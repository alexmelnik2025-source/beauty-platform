-- Client app "My visits": a person across salons, sign-in codes and device sessions.

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "locale" "locale" NOT NULL DEFAULT 'pl',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_login_code" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_login_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_session" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "client_type" "client_type" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "person_email_key" ON "person"("email");

-- CreateIndex
CREATE UNIQUE INDEX "client_login_code_email_key" ON "client_login_code"("email");

-- CreateIndex
CREATE UNIQUE INDEX "client_session_token_hash_key" ON "client_session"("token_hash");

-- CreateIndex
CREATE INDEX "client_session_person_id_idx" ON "client_session"("person_id");

-- CreateIndex
CREATE INDEX "customer_email_idx" ON "customer"("email");

-- AddForeignKey
ALTER TABLE "client_session" ADD CONSTRAINT "client_session_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
