/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Logowanie użytkownika
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: password123
 *     responses:
 *       200:
 *         description: Logowanie udane
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT token
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Błąd walidacji
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Nieprawidłowe dane logowania
 */

/**
 * @swagger
 * /api/providers/match-top:
 *   get:
 *     summary: AI Matching TOP 3 wykonawców
 *     description: Inteligentne dopasowywanie najlepszych wykonawców dla zlecenia na podstawie lokalizacji, ocen, dostępności i innych czynników
 *     tags: [Providers, AI]
 *     parameters:
 *       - in: query
 *         name: serviceCode
 *         required: true
 *         schema:
 *           type: string
 *         description: Kod usługi (np. "hydraulik", "elektryk")
 *         example: hydraulik
 *       - in: query
 *         name: lat
 *         schema:
 *           type: number
 *           format: float
 *         description: Szerokość geograficzna
 *         example: 52.2297
 *       - in: query
 *         name: lng
 *         schema:
 *           type: number
 *           format: float
 *         description: Długość geograficzna
 *         example: 21.0122
 *       - in: query
 *         name: urgency
 *         schema:
 *           type: string
 *           enum: [normal, today, now]
 *           default: normal
 *         description: Pilność zlecenia
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 3
 *           minimum: 1
 *           maximum: 10
 *         description: Maksymalna liczba wyników
 *     responses:
 *       200:
 *         description: Lista dopasowanych wykonawców
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 providers:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Provider'
 *                 count:
 *                   type: integer
 *                 serviceCode:
 *                   type: string
 *                 cached:
 *                   type: boolean
 *                   description: Czy wynik pochodzi z cache
 *       400:
 *         description: Błąd walidacji
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/orders:
 *   post:
 *     summary: Utworzenie nowego zlecenia
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - service
 *               - description
 *             properties:
 *               service:
 *                 type: string
 *                 description: ID lub kod usługi
 *               description:
 *                 type: string
 *                 description: Opis zlecenia
 *               locationText:
 *                 type: string
 *               lat:
 *                 type: number
 *                 format: float
 *               lng:
 *                 type: number
 *                 format: float
 *               urgency:
 *                 type: string
 *                 enum: [normal, today, now]
 *               amountTotal:
 *                 type: integer
 *                 description: Kwota w groszach (opcjonalna)
 *     responses:
 *       201:
 *         description: Zlecenie utworzone
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       400:
 *         description: Błąd walidacji
 *       401:
 *         description: Brak autoryzacji
 */

