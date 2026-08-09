FROM node:18-alpine

# Prisma's query engine needs OpenSSL, which the Alpine base image omits.
# Without this Prisma warns it "failed to detect the libssl/openssl version"
# and can fail to load the engine at runtime.
RUN apk add --no-cache openssl

WORKDIR /app

# The Prisma schema must be present BEFORE `npm install`, because this
# package.json runs `prisma generate` as a postinstall hook and that hook
# looks for prisma/schema.prisma. Copying only the manifests here (the usual
# layer-caching trick) makes postinstall fail with "Could not find Prisma
# Schema".
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# A full install on purpose — no `--omit=dev`. The `prisma` CLI is a
# devDependency and is needed twice: by the postinstall hook here, and by
# `prisma db push` when the container starts.
#
# DATABASE_URL is scoped to this one command: `prisma generate` resolves the
# datasource env var, but the real value is injected by the host at runtime.
# Setting it via ENV would leak a bogus default into the running container.
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npm install

# Application source. Kept after the install so dependency layers stay cached
# across code-only changes.
COPY . .

EXPOSE 8080

# Schema push + boot live in scripts/start.sh so the Dockerfile and Railway's
# startCommand run the exact same sequence.
CMD ["sh", "scripts/start.sh"]
