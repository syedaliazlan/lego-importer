import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Test database connection on startup
prisma.$connect()
  .then(() => {
    console.log("[Prisma] Successfully connected to database");
    // Test query
    return prisma.session.count();
  })
  .then((count) => {
    console.log("[Prisma] Session table has", count, "rows");
  })
  .catch((error) => {
    console.error("[Prisma] Failed to connect to database:", error.message);
    console.error("[Prisma] DATABASE_URL:", process.env.DATABASE_URL?.substring(0, 50) + "...");
  });

export default prisma;
