FROM oven/bun:1.4.2 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend/package.json frontend/bun.lock ./frontend/
RUN cd frontend && bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY frontend ./frontend
RUN cd frontend && bun run build

FROM oven/bun:1.4.2

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/frontend/dist ./frontend/dist

EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
