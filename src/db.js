import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('warn', (e) => logger.warn({ prisma: e.message }, 'prisma warning'));
prisma.$on('error', (e) => logger.error({ prisma: e.message }, 'prisma error'));

export default prisma;
