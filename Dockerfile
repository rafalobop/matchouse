FROM node:20-slim

# Definir directorio de trabajo
WORKDIR /app

# Copiar configuración de dependencias e instalar
COPY package*.json ./
RUN npm ci

# Copiar el código del proyecto y compilar
COPY . .
RUN npm run build

# Arrancar la aplicación
CMD ["npm", "start"]
