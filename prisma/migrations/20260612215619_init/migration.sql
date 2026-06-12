-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "domicilio" TEXT NOT NULL,
    "pisoLote" TEXT,
    "precio" DOUBLE PRECISION NOT NULL,
    "moneda" TEXT NOT NULL,
    "expensas" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dormitorios" INTEGER NOT NULL DEFAULT 0,
    "caracteristicas" TEXT,
    "contacto" TEXT,
    "zona" TEXT NOT NULL,
    "operacion" TEXT NOT NULL,
    "tipoPropiedad" TEXT NOT NULL,
    "sheetName" TEXT NOT NULL,
    "latitud" DOUBLE PRECISION,
    "longitud" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "validationScore" DOUBLE PRECISION NOT NULL,
    "isValid" BOOLEAN NOT NULL,
    "reasoning" TEXT NOT NULL,
    "matchDetails" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
