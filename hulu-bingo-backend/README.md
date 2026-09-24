# Hulu Bingo Backend

## Stack
- Node.js + Express
- PostgreSQL
- Socket.IO
- JWT authentication
- bcrypt password hashing

## Why this backend
The frontend is intentionally plain HTML/CSS/JavaScript so it is easy to learn and edit in VS Code.
Node.js/Express is a good match for this frontend and real-time Bingo.
PostgreSQL is used because users, wallets, games, tickets and transactions are relational data that should be stored reliably.

## Setup
1. Install PostgreSQL.
2. Create database:
   `CREATE DATABASE hulu_bingo;`
3. Copy `.env.example` to `.env`.
4. Change DATABASE_URL and JWT_SECRET.
5. Run:
   `npm install`
   `npm start`

The API runs on port 4000.

## Frontend
Open `frontend/index.html` through VS Code Live Server on port 5500, or serve the frontend with any static server.

## Game rules in this prototype
- Entry = 10 ETB.
- Deposit minimum = 50 ETB.
- If players <= 3, the prize pool gets 10 ETB per player.
- If players > 3, the platform fee is 2 ETB per player and the prize pool gets 8 ETB per player.
- Tickets use 25 unique numbers from 1–150.
- Bingo = row, column or diagonal.
- The server calls one number every 5 seconds.
- First detected Bingo ends the game and receives the current prize pool.

## Production warning
Payment methods are only request placeholders. Do not connect this prototype to real money until payment verification, authorization, transaction idempotency, audit logs, rate limiting, fraud controls, age/identity requirements, responsible-gaming controls and all applicable Ethiopian legal/compliance requirements have been reviewed and implemented.
