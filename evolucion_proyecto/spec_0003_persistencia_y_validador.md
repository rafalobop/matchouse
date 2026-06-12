# SPEC-0003: Persistencia con PostgreSQL (Prisma) y Agente Validador de Matches

## 1. Contexto y Objetivos
Para escalar HouseMatch a 10 clientes de forma robusta en Railway, se requiere:
1.  **Persistencia Relacional**: Sustituir el almacenamiento efímero local (`catalog.json`, arrays en memoria) y sincronizar Google Sheets/Excel en tablas de PostgreSQL usando Prisma ORM. La base de datos estará alojada en el proyecto **matchouse** de **Supabase** y se conectará mediante la variable de entorno `DATABASE_URL`.
2.  **Agente Validador (Gatekeeper)**: Incorporar un nuevo sub-agente basado en LLM que actúe después del algoritmo físico de matching para validar la calidad del match, reduciendo falsos positivos e impidiendo notificaciones de bajo score.


## 2. Arquitectura de Datos (Esquema Prisma Propuesto)

```prisma
model Property {
  id              String   @id @default(uuid())
  domicilio       String
  pisoLote        String?
  precio          Float
  moneda          String
  expensas        Float    @default(0)
  dormitorios     Int      @default(0)
  caracteristicas String?
  contacto        String?
  zona            String
  operacion       String
  tipoPropiedad   String
  sheetName       String
  latitud         Float?
  longitud        Float?
  createdAt       DateTime @default(now())
  matches         Match[]
}

model Message {
  id           String   @id @default(uuid())
  body         String
  sender       String
  groupName    String
  senderPhone  String
  timestamp    DateTime @default(now())
  matches      Match[]
}

model Match {
  id              String   @id @default(uuid())
  messageId       String
  propertyId      String
  score           Float
  validationScore Float
  isValid         Boolean
  reasoning       String
  matchDetails    String
  fecha           DateTime @default(now())

  message         Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  property        Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)
}
```

## 3. Flujo de Trabajo del Agente Validador

El Agente Validador se ejecuta en el Coordinador de la siguiente manera:
1.  El algoritmo de matching físico encuentra un match matemático.
2.  Se invoca al **Agente Validador** con:
    - El pedido original del cliente.
    - Las características estructuradas extraídas.
    - La propiedad coincidente seleccionada.
3.  El LLM evalúa cualitativamente la coherencia (ej: "Doble cochera", "Solo estudiantes").
4.  Si el validador determina que `isValid === true` (score > 70%), se procede a enviar la notificación de WhatsApp. Si no, se registra en la base de datos pero se marca como inválido y **no se envía la notificación**.
