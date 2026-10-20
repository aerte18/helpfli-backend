#!/usr/bin/env node

/**
 * Read-only preflight for unique keys introduced by the Stripe/payment flow.
 *
 * The script intentionally does not load Mongoose models. This prevents model
 * initialization from creating/synchronizing indexes while the preflight is
 * inspecting production data.
 *
 * Usage (from backend/):
 *   MONGO_URI='mongodb+srv://...' npm run db:preflight:payment-unique
 */

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const MAX_REPORTED_GROUPS = 50;
const DEFAULT_MAX_TIME_MS = 120000;

// Keep this list in sync with the new unique indexes in backend/models.
// `match` mirrors each partialFilterExpression. A regular unique index has no
// match and is therefore checked across every document in the collection.
const UNIQUE_KEY_CHECKS = [
  {
    label: 'Payment.stripePaymentIntentId',
    collection: 'payments',
    fields: ['stripePaymentIntentId'],
    match: { stripePaymentIntentId: { $type: 'string' } },
  },
  {
    label: 'Payment.stripeBusinessKey',
    collection: 'payments',
    fields: ['stripeBusinessKey'],
    match: { stripeBusinessKey: { $type: 'string' } },
  },
  {
    label: 'Notification.dedupeKey',
    collection: 'notifications',
    fields: ['dedupeKey'],
    match: { dedupeKey: { $type: 'string' } },
  },
  {
    label: 'Revenue.stripeSourceId + type',
    collection: 'revenues',
    fields: ['stripeSourceId', 'type'],
    match: { stripeSourceId: { $type: 'string' } },
  },
  {
    label: 'Boost.stripePaymentIntentId + stripeItemIndex',
    collection: 'boosts',
    fields: ['stripePaymentIntentId', 'stripeItemIndex'],
    match: { stripePaymentIntentId: { $type: 'string' } },
  },
  {
    label: 'PromotionPurchase.stripePaymentIntentId',
    collection: 'promotionpurchases',
    fields: ['stripePaymentIntentId'],
    match: { stripePaymentIntentId: { $type: 'string' } },
  },
  {
    label: 'Promotion.stripeCheckoutSessionId',
    collection: 'promotions',
    fields: ['stripeCheckoutSessionId'],
    match: { stripeCheckoutSessionId: { $type: 'string' } },
  },
  {
    label: 'ProSubscription.stripeCheckoutSessionId',
    collection: 'prosubscriptions',
    fields: ['stripeCheckoutSessionId'],
    match: { stripeCheckoutSessionId: { $type: 'string' } },
  },
  {
    label: 'SponsorCampaign.stripeCheckoutSessionId',
    collection: 'sponsorcampaigns',
    fields: ['stripeCheckoutSessionId'],
    match: { stripeCheckoutSessionId: { $type: 'string' } },
  },
  {
    label: 'PaymentRefundAudit.idempotencyKey',
    collection: 'paymentrefundaudits',
    fields: ['idempotencyKey'],
    // This is a regular (not partial/sparse) unique index, so missing, null and
    // malformed legacy values must also participate in duplicate detection.
    match: null,
  },
  {
    label: 'DisputeRefundExecution.executionKey',
    collection: 'disputerefundexecutions',
    fields: ['executionKey'],
    // The journal must have exactly one durable plan for every settlement.
    match: null,
  },
];

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildDuplicatePipeline(check) {
  // MongoDB indexes both an absent scalar field and an explicit null as the
  // same null key. Normalize them here so the preflight cannot miss that
  // collision (also relevant to the second field of compound indexes).
  const key = Object.fromEntries(
    check.fields.map((field) => [field, { $ifNull: [`$${field}`, null] }])
  );
  const pipeline = [];

  if (check.match) pipeline.push({ $match: check.match });

  pipeline.push(
    { $group: { _id: key, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    {
      $facet: {
        summary: [{ $count: 'duplicateGroups' }],
        groups: [
          { $sort: { count: -1 } },
          { $limit: MAX_REPORTED_GROUPS },
        ],
      },
    }
  );

  return pipeline;
}

function formatKey(key) {
  return JSON.stringify(key, (_name, value) => {
    if (value && typeof value === 'object' && value._bsontype === 'ObjectId') {
      return value.toHexString();
    }
    return value;
  });
}

async function inspectCheck(db, check, maxTimeMS) {
  const [result = {}] = await db
    .collection(check.collection)
    .aggregate(buildDuplicatePipeline(check), {
      allowDiskUse: true,
      maxTimeMS,
      readConcern: { level: 'majority' },
    })
    .toArray();

  return {
    ...check,
    duplicateGroups: result.summary?.[0]?.duplicateGroups || 0,
    groups: result.groups || [],
  };
}

function printHelp() {
  console.log([
    'Read-only preflight for payment/Stripe unique indexes.',
    '',
    'Required environment:',
    '  MONGO_URI  MongoDB connection string for the database being deployed',
    '',
    'Optional environment:',
    `  PAYMENT_INDEX_PREFLIGHT_MAX_TIME_MS  aggregation timeout (default: ${DEFAULT_MAX_TIME_MS})`,
  ].join('\n'));
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return 0;
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri || typeof mongoUri !== 'string' || !mongoUri.trim()) {
    console.error('ERROR: MONGO_URI is required. No database was inspected.');
    return 2;
  }

  const maxTimeMS = readPositiveInteger(
    process.env.PAYMENT_INDEX_PREFLIGHT_MAX_TIME_MS,
    DEFAULT_MAX_TIME_MS
  );

  try {
    // No models are registered and both automatic schema operations are
    // disabled. Every operation below is an aggregate read.
    await mongoose.connect(mongoUri, {
      autoCreate: false,
      autoIndex: false,
      readPreference: 'primary',
      serverSelectionTimeoutMS: 15000,
    });

    const db = mongoose.connection.db;
    console.log(`Payment unique-index preflight: database "${db.databaseName}"`);
    console.log(`Mode: READ ONLY | checks: ${UNIQUE_KEY_CHECKS.length}`);

    let failed = false;
    for (const check of UNIQUE_KEY_CHECKS) {
      const result = await inspectCheck(db, check, maxTimeMS);
      if (result.duplicateGroups === 0) {
        console.log(`PASS  ${check.label} (${check.collection})`);
        continue;
      }

      failed = true;
      console.error(
        `FAIL  ${check.label} (${check.collection}): ` +
        `${result.duplicateGroups} duplicate key group(s)`
      );
      for (const group of result.groups) {
        console.error(`      count=${group.count} key=${formatKey(group._id)}`);
      }
      if (result.duplicateGroups > result.groups.length) {
        console.error(
          `      ... ${result.duplicateGroups - result.groups.length} more group(s) not printed`
        );
      }
    }

    if (failed) {
      console.error('\nBLOCKED: resolve duplicate keys before deploying the new unique indexes.');
      console.error('No data or indexes were modified by this script.');
      return 1;
    }

    console.log('\nPASS: no duplicate keys found. No data or indexes were modified.');
    return 0;
  } catch (error) {
    console.error(`ERROR: preflight could not complete (${error.name || 'Error'}): ${error.message}`);
    console.error('No data or indexes were modified by this script.');
    return 2;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`ERROR: unexpected preflight failure: ${error.message}`);
      process.exitCode = 2;
    });
}

module.exports = {
  UNIQUE_KEY_CHECKS,
  buildDuplicatePipeline,
  inspectCheck,
  readPositiveInteger,
};
