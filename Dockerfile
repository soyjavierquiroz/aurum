# Imagen base
FROM node:20-alpine

# Directorio de trabajo (igual al volumen del stack)
WORKDIR /opt/projects/aurum

# Copiamos manifiestos e instalamos deps (para que también funcione sin volumen)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copiamos el código
COPY src ./src
COPY package.json ./

EXPOSE 4001
CMD ["npm", "start"]
