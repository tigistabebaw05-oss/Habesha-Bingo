-- =========================================================
-- HULU BINGO DATABASE
-- MySQL 8.x
-- =========================================================

CREATE DATABASE IF NOT EXISTS hulu_bingo;

USE hulu_bingo;


-- =========================================================
-- 1. USERS
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL UNIQUE,
    email VARCHAR(150) UNIQUE,
    password_hash TEXT NOT NULL,

    role VARCHAR(20) NOT NULL DEFAULT 'player',

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    CHECK (role IN ('player', 'admin'))
);


-- =========================================================
-- 2. WALLETS
-- =========================================================

CREATE TABLE IF NOT EXISTS wallets (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT NOT NULL UNIQUE,

    main_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00,

    vip_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    CHECK (main_balance >= 0),
    CHECK (vip_balance >= 0),

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);
-- 3. GAMES
-- =========================================================

CREATE TABLE IF NOT EXISTS games (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    game_code VARCHAR(30) NOT NULL UNIQUE,

    game_name VARCHAR(100) NOT NULL DEFAULT 'Main Bingo',

    room_type VARCHAR(20) NOT NULL DEFAULT 'main',

    entry_fee DECIMAL(10,2) NOT NULL DEFAULT 10.00,

    platform_fee_per_player DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    prize_per_player DECIMAL(10,2) NOT NULL DEFAULT 10.00,

    player_count INT NOT NULL DEFAULT 0,

    prize_pool DECIMAL(14,2) NOT NULL DEFAULT 0.00,

    platform_fee_total DECIMAL(14,2) NOT NULL DEFAULT 0.00,

    status VARCHAR(20) NOT NULL DEFAULT 'waiting',

    current_number INT NULL,

    called_numbers JSON NOT NULL,

    winner_user_id BIGINT NULL,

    winner_ticket JSON NULL,

    started_at TIMESTAMP NULL,

    finished_at TIMESTAMP NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (room_type IN ('main', 'vip')),

    CHECK (status IN ('waiting', 'running', 'finished', 'cancelled')),

    CHECK (
        current_number IS NULL
        OR current_number BETWEEN 1 AND 150
    ),

    FOREIGN KEY (winner_user_id)
        REFERENCES users(ID)
        ON DELETE SET NULL
);


-- =========================================================
-- 4. BINGO TICKETS
-- =========================================================

CREATE TABLE IF NOT EXISTS bingo_tickets (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    game_id BIGINT NOT NULL,

    user_id BIGINT NOT NULL,

    numbers JSON NOT NULL,

    is_winner BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (game_id, user_id),

    FOREIGN KEY (game_id)
        REFERENCES games(ID)
        ON DELETE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 5. GAME PLAYERS
-- =========================================================

CREATE TABLE IF NOT EXISTS game_players (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    game_id BIGINT NOT NULL,

    user_id BIGINT NOT NULL,

    entry_amount DECIMAL(10,2) NOT NULL DEFAULT 10.00,

    platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    prize_contribution DECIMAL(10,2) NOT NULL DEFAULT 10.00,

    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (game_id, user_id),

    FOREIGN KEY (game_id)
        REFERENCES games(ID)
        ON DELETE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 6. WALLET TRANSACTIONS
-- =========================================================

CREATE TABLE IF NOT EXISTS wallet_transactions (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT NOT NULL,

    wallet_type VARCHAR(20) NOT NULL DEFAULT 'main',

    transaction_type VARCHAR(30) NOT NULL,

    amount DECIMAL(14,2) NOT NULL,

    balance_before DECIMAL(14,2) NULL,

    balance_after DECIMAL(14,2) NULL,

    payment_method VARCHAR(30) NULL,

    reference VARCHAR(150) NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    note TEXT,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    processed_at TIMESTAMP NULL,

    CHECK (wallet_type IN ('main', 'vip')),

    CHECK (
        transaction_type IN (
            'deposit',
            'withdrawal',
            'game_entry',
            'prize',
            'refund',
            'platform_fee'
        )
    ),

    CHECK (
        status IN (
            'pending',
            'approved',
            'rejected',
            'completed'
        )
    ),

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 7. DEPOSIT REQUESTS
-- =========================================================

CREATE TABLE IF NOT EXISTS deposit_requests (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT NOT NULL,

    wallet_type VARCHAR(20) NOT NULL DEFAULT 'main',

    amount DECIMAL(14,2) NOT NULL,

    payment_method VARCHAR(30) NOT NULL,

    reference VARCHAR(150) NULL,

    sender_phone VARCHAR(30) NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    admin_note TEXT,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    processed_at TIMESTAMP NULL,

    CHECK (wallet_type IN ('main', 'vip')),

    CHECK (amount >= 50.00),

    CHECK (
        payment_method IN (
            'TeleBirr',
            'CBE Birr',
            'M-Pesa',
            'E-Birr'
        )
    ),

    CHECK (
        status IN (
            'pending',
            'approved',
            'rejected'
        )
    ),

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 8. WITHDRAWAL REQUESTS
-- =========================================================

CREATE TABLE IF NOT EXISTS withdrawal_requests (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT NOT NULL,

    wallet_type VARCHAR(20) NOT NULL DEFAULT 'main',

    amount DECIMAL(14,2) NOT NULL,

    payment_method VARCHAR(30) NOT NULL,

    account_number VARCHAR(50) NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    admin_note TEXT,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    processed_at TIMESTAMP NULL,

    CHECK (wallet_type IN ('main', 'vip')),

    CHECK (amount > 0),

    CHECK (
        payment_method IN (
            'TeleBirr',
            'CBE Birr',
            'M-Pesa',
            'E-Birr'
        )
    ),

    CHECK (
        status IN (
            'pending',
            'approved',
            'rejected',
            'completed'
        )
    ),

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 9. WINNERS
-- =========================================================

CREATE TABLE IF NOT EXISTS winners (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    game_id BIGINT NOT NULL,

    user_id BIGINT NOT NULL,

    prize_amount DECIMAL(14,2) NOT NULL,

    winning_pattern VARCHAR(30) NULL,

    ticket_snapshot JSON NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (game_id, user_id),

    FOREIGN KEY (game_id)
        REFERENCES games(ID)
        ON DELETE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 10. GAME NUMBER CALLS
-- =========================================================

CREATE TABLE IF NOT EXISTS game_number_calls (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    game_id BIGINT NOT NULL,

    number_called INT NOT NULL,

    call_order INT NOT NULL,

    called_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (game_id, number_called),

    UNIQUE (game_id, call_order),

    CHECK (
        number_called BETWEEN 1 AND 150
    ),

    FOREIGN KEY (game_id)
        REFERENCES games(ID)
        ON DELETE CASCADE
);


-- =========================================================
-- 11. AUDIT LOGS
-- =========================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT NULL,

    action VARCHAR(100) NOT NULL,

    entity_type VARCHAR(50) NULL,

    entity_id BIGINT NULL,

    details JSON NULL,

    ip_address VARCHAR(45) NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(ID)
        ON DELETE SET NULL
);


-- =========================================================
-- 12. INDEXES
-- =========================================================

CREATE INDEX idx_games_status
ON games(status);

CREATE INDEX idx_game_players_game
ON game_players(game_id);

CREATE INDEX idx_game_players_user
ON game_players(user_id);

CREATE INDEX idx_tickets_game
ON bingo_tickets(game_id);

CREATE INDEX idx_tickets_user
ON bingo_tickets(user_id);

CREATE INDEX idx_transactions_user
ON wallet_transactions(user_id);

CREATE INDEX idx_transactions_status
ON wallet_transactions(status);

CREATE INDEX idx_deposits_status
ON deposit_requests(status);

CREATE INDEX idx_withdrawals_status
ON withdrawal_requests(status);

CREATE INDEX idx_audit_user
ON audit_logs(user_id);


-- =========================================================
-- 13. CREATE FIRST GAME
-- =========================================================

INSERT INTO games (
    game_code,
    game_name,
    room_type,
    entry_fee,
    status,
    called_numbers
)
SELECT
    'MAIN-001',
    'Main Bingo',
    'main',
    10.00,
    'waiting',
    JSON_ARRAY()
WHERE NOT EXISTS (
    SELECT 1
    FROM games
    WHERE game_code = 'MAIN-001'
);


-- =========================================================
-- 14. PLAYER WALLET VIEW
-- =========================================================

CREATE OR REPLACE VIEW player_wallets AS
SELECT
    u.ID AS user_id,
    u.full_name,
    u.phone,
    u.role,

    COALESCE(w.main_balance, 0.00) AS main_balance,

    COALESCE(w.vip_balance, 0.00) AS vip_balance

FROM users u

LEFT JOIN wallets w
    ON w.user_id = u.ID;


-- =========================================================
-- 15. GAME SUMMARY VIEW
-- =========================================================

CREATE OR REPLACE VIEW game_summary AS
SELECT
    g.ID,
    g.game_code,
    g.game_name,
    g.room_type,
    g.entry_fee,

    COUNT(gp.ID) AS players,

    COALESCE(
        SUM(gp.prize_contribution),
        0.00
    ) AS calculated_prize_pool,

    COALESCE(
        SUM(gp.platform_fee),
        0.00
    ) AS calculated_platform_fee,

    g.status,
    g.current_number,
    g.created_at,
    g.started_at,
    g.finished_at

FROM games g

LEFT JOIN game_players gp
    ON gp.game_id = g.ID

GROUP BY
    g.ID,
    g.game_code,
    g.game_name,
    g.room_type,
    g.entry_fee,
    g.status,
    g.current_number,
    g.created_at,
    g.started_at,
    g.finished_at;


-- =========================================================
-- BUSINESS RULE
-- =========================================================
--
-- 3 or fewer players:
--     Entry = 10 ETB
--     Platform fee = 0 ETB
--     Prize contribution = 10 ETB
--
-- More than 3 players:
--     Entry = 10 ETB
--     Platform fee = 2 ETB
--     Prize contribution = 8 ETB
--
-- Example:
-- 10 players
-- Total collected = 100 ETB
-- Platform fee = 20 ETB
-- Prize pool = 80 ETB
--
-- IMPORTANT:
-- The backend must enforce these rules.
-- Never trust the browser/frontend for wallet balances.
-- =========================================================
SHOW CREATE TABLE users;