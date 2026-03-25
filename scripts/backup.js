#!/usr/bin/env node

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Configuration
const config = {
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli',
  backupDir: process.env.BACKUP_DIR || path.join(__dirname, '../backups'),
  maxBackups: parseInt(process.env.MAX_BACKUPS) || 7, // Keep 7 days of backups
  compression: process.env.BACKUP_COMPRESSION !== 'false', // Default to true
  s3Bucket: process.env.AWS_S3_BACKUP_BUCKET,
  awsRegion: process.env.AWS_REGION || 'eu-central-1'
};

// Ensure backup directory exists
if (!fs.existsSync(config.backupDir)) {
  fs.mkdirSync(config.backupDir, { recursive: true });
}

// Generate backup filename with timestamp
function getBackupFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const extension = config.compression ? 'gz' : 'bson';
  return `helpfli-backup-${timestamp}.${extension}`;
}

// Create MongoDB backup
function createBackup() {
  return new Promise((resolve, reject) => {
    const filename = getBackupFilename();
    const filepath = path.join(config.backupDir, filename);
    
    // Extract database name from URI
    const dbName = config.mongoUri.split('/').pop().split('?')[0];
    
    // Build mongodump command
    let command = `mongodump --uri="${config.mongoUri}" --out="${config.backupDir}/temp"`;
    
    if (config.compression) {
      command += ` && tar -czf "${filepath}" -C "${config.backupDir}/temp" .`;
    } else {
      command += ` && mv "${config.backupDir}/temp/${dbName}" "${filepath}"`;
    }
    
    command += ` && rm -rf "${config.backupDir}/temp"`;
    
    console.log(`🔄 Creating backup: ${filename}`);
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Backup failed: ${error.message}`);
        reject(error);
        return;
      }
      
      if (stderr) {
        console.warn(`⚠️ Backup warning: ${stderr}`);
      }
      
      console.log(`✅ Backup created: ${filename}`);
      console.log(`📁 Location: ${filepath}`);
      
      // Upload to S3 if configured
      if (config.s3Bucket) {
        uploadToS3(filepath, filename)
          .then(() => resolve(filepath))
          .catch(err => {
            console.error(`❌ S3 upload failed: ${err.message}`);
            resolve(filepath); // Still resolve as backup was created locally
          });
      } else {
        resolve(filepath);
      }
    });
  });
}

// Upload backup to S3
function uploadToS3(filepath, filename) {
  return new Promise((resolve, reject) => {
    if (!config.s3Bucket) {
      resolve();
      return;
    }

    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const fileContent = fs.readFileSync(filepath);
    const key = `backups/${filename}`;
    const client = new S3Client({ region: config.awsRegion });

    client
      .send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: key,
          Body: fileContent,
          ContentType: config.compression ? 'application/gzip' : 'application/octet-stream',
          ServerSideEncryption: 'AES256'
        })
      )
      .then(() => {
        console.log(`☁️ Backup uploaded to S3: s3://${config.s3Bucket}/${key}`);
        resolve();
      })
      .catch(reject);
  });
}

// Clean old backups
function cleanOldBackups() {
  return new Promise((resolve, reject) => {
    fs.readdir(config.backupDir, (err, files) => {
      if (err) {
        reject(err);
        return;
      }
      
      // Filter backup files
      const backupFiles = files
        .filter(file => file.startsWith('helpfli-backup-'))
        .map(file => ({
          name: file,
          path: path.join(config.backupDir, file),
          stats: fs.statSync(path.join(config.backupDir, file))
        }))
        .sort((a, b) => b.stats.mtime - a.stats.mtime); // Sort by modification time, newest first
      
      // Remove old backups
      if (backupFiles.length > config.maxBackups) {
        const filesToDelete = backupFiles.slice(config.maxBackups);
        
        filesToDelete.forEach(file => {
          fs.unlinkSync(file.path);
          console.log(`🗑️ Deleted old backup: ${file.name}`);
        });
        
        console.log(`🧹 Cleaned ${filesToDelete.length} old backups`);
      }
      
      resolve();
    });
  });
}

// Restore from backup
function restoreBackup(backupPath) {
  return new Promise((resolve, reject) => {
    const dbName = config.mongoUri.split('/').pop().split('?')[0];
    
    let command;
    if (backupPath.endsWith('.gz')) {
      // Compressed backup
      command = `tar -xzf "${backupPath}" -C "${config.backupDir}/temp" && mongorestore --uri="${config.mongoUri}" --drop "${config.backupDir}/temp/${dbName}" && rm -rf "${config.backupDir}/temp"`;
    } else {
      // Uncompressed backup
      command = `mongorestore --uri="${config.mongoUri}" --drop "${backupPath}"`;
    }
    
    console.log(`🔄 Restoring from backup: ${backupPath}`);
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Restore failed: ${error.message}`);
        reject(error);
        return;
      }
      
      if (stderr) {
        console.warn(`⚠️ Restore warning: ${stderr}`);
      }
      
      console.log(`✅ Database restored from backup`);
      resolve();
    });
  });
}

// Main backup function
async function runBackup() {
  try {
    console.log(`🚀 Starting backup process...`);
    console.log(`📅 ${new Date().toISOString()}`);
    
    await createBackup();
    await cleanOldBackups();
    
    console.log(`✅ Backup process completed successfully`);
  } catch (error) {
    console.error(`❌ Backup process failed: ${error.message}`);
    process.exit(1);
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args[0] === 'restore' && args[1]) {
    restoreBackup(args[1])
      .then(() => {
        console.log('✅ Restore completed');
        process.exit(0);
      })
      .catch(err => {
        console.error('❌ Restore failed:', err.message);
        process.exit(1);
      });
  } else {
    runBackup();
  }
}

// Schedule backups if running as cron job
if (process.env.BACKUP_SCHEDULE) {
  console.log(`⏰ Scheduling backups with cron: ${process.env.BACKUP_SCHEDULE}`);
  cron.schedule(process.env.BACKUP_SCHEDULE, runBackup);
}

module.exports = {
  createBackup,
  restoreBackup,
  cleanOldBackups,
  runBackup
};
