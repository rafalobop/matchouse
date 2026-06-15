import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import dns from 'dns';

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  lookup: (hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void) => {
    dns.lookup(hostname, { ...options, family: 4 }, callback);
  }
} as any);
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

