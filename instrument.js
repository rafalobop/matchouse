// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");
const path = require("path");
const fs = require("fs");

// KAN-126: mismo patrón dev/prod de resolución de ruta que dashboardPath en src/index.ts. En
// producción (`node -r ./instrument.js dist/index.js`) hace falta el .js ya compilado; en
// desarrollo (`ts-node -r ./instrument.js src/index.ts`) ts-node ya registró su hook de require
// para cuando este archivo corre, así que puede requerir el .ts fuente directamente.
const compiledSentryConfigPath = path.join(__dirname, "dist", "config", "sentryDataCollection.js");
const { buildSentryDataCollectionConfig } = require(
  fs.existsSync(compiledSentryConfigPath)
    ? compiledSentryConfigPath
    : path.join(__dirname, "src", "config", "sentryDataCollection")
);

Sentry.init({
  dsn: "https://612bb75a635df3d64b56fc88c4aa5c66@o4511038748950528.ingest.us.sentry.io/4511978708729856",
  // KAN-126: antes acá "dataCollection" quedaba comentado por default — Sentry capturaba bodies
  // HTTP completos (emails, access_token, datos de perfil) y cookies/headers sin filtrar,
  // incluida la cookie de sesión y el header Authorization en texto plano. Ver
  // src/config/sentryDataCollection.ts para el detalle de qué se excluye y por qué, y
  // docs/sentry-security-audit.md para el plan de auditoría periódica de esta configuración.
  dataCollection: buildSentryDataCollectionConfig(),
});
