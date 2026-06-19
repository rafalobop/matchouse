FROM node:20-slim

# Definir directorio de trabajo
WORKDIR /app

# Instalar pnpm
RUN npm install -g pnpm

# Copiar configuración de dependencias e instalar
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copiar el código del proyecto y compilar
COPY . .
RUN pnpm run build

# Arrancar la aplicación
CMD ["pnpm", "start"]
