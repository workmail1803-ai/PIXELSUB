FROM node:18-alpine

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --legacy-peer-deps --production

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

EXPOSE 8080

# Ensure database schema is applied at container start and then start the app
CMD ["sh", "-c", "npx prisma db push --skip-generate && node src/index.js"]
