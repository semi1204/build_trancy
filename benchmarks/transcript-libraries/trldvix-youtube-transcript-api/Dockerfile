FROM gradle:8.13-jdk21 AS build

WORKDIR /src
COPY settings.gradle.kts build.gradle.kts ./
COPY src ./src
RUN gradle --no-daemon installDist

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/build/install/trldvix-adapter/ ./

ENTRYPOINT ["/app/bin/trldvix-adapter"]
