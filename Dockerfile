FROM apify/actor-node:20

# Copy dependency manifests and install (including dev deps for TS build)
COPY package*.json ./
RUN npm install --include=dev --audit=false

# Copy source and compile TypeScript
COPY . ./
RUN npm run build

# Remove dev dependencies to shrink the image
RUN npm prune --omit=dev --omit=optional

# Start the Actor
CMD npm run start:prod
