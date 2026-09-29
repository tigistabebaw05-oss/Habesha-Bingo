-- Habesha Bingo PostgreSQL schema

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(30) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER', 'ADMIN', 'OWNER')),
    telegram_id BIGINT UNIQUE,
    telegram_username VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    main_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (main_balance >= 0),
    vip_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (vip_balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL DEFAULT 'Main Game',
    entry NUMERIC(12,2) NOT NULL DEFAULT 10,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','finished','cancelled')),
    prize_pool NUMERIC(14,2) NOT NULL DEFAULT 0,
    platform_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
    current_number INTEGER CHECK (current_number IS NULL OR current_number BETWEEN 1 AND 150),
    called_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
    winner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    winner_ticket JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tickets (
    id BIGSERIAL PRIMARY KEY,
    game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    numbers JSONB NOT NULL,
    UNIQUE (game_id, user_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL CHECK (type IN ('deposit','withdrawal','game_entry','prize','refund','platform_fee')),
    wallet VARCHAR(20) NOT NULL DEFAULT 'main' CHECK (wallet IN ('main','vip')),
    amount NUMERIC(14,2) NOT NULL,
    balance_before NUMERIC(14,2),
    balance_after NUMERIC(14,2),
        provider VARCHAR(30),
        provider_reference VARCHAR(150),
        idempotency_key VARCHAR(100),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        failure_reason TEXT,
        processed_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed')),
    method VARCHAR(30),
    reference VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS winners (
    id BIGSERIAL PRIMARY KEY,
    game_id BIGINT NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prize_amount NUMERIC(14,2) NOT NULL CHECK (prize_amount >= 0),
    ticket_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id BIGINT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(80) PRIMARY KEY,
    value VARCHAR(200) NOT NULL,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_messages (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    subject VARCHAR(150) NOT NULL DEFAULT 'General Inquiry',
    message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
    admin_reply TEXT,
    replied_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    replied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_tickets_game ON tickets(game_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_messages(status);

INSERT INTO games (name)
SELECT 'Main Game'
WHERE NOT EXISTS (SELECT 1 FROM games WHERE status IN ('waiting', 'running'));

INSERT INTO app_settings(key, value)
VALUES ('demo_mode', 'true'), ('demo_entry_amount', '10'), ('demo_min_deposit', '50'),
       ('demo_min_withdrawal', '100'), ('demo_number_max', '150')
ON CONFLICT (key) DO NOTHING;
