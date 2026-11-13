# syntax=docker/dockerfile:1
ARG VALHALLA_IMAGE=ghcr.io/valhalla/valhalla-scripted:3.9.1@sha256:6238809f9dc3057743d70a20efd3911ec38e458bfa13a0601909b58f68dfd956
FROM eclipse-temurin:21-jre-noble@sha256:0d57a8e90c2bb844c5a8e1b2b71e11eff06dad7edcfd803cd21ed4ae203b2515 AS java
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node
FROM ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:3d7a08f7e78b356ee873b61711b743ad81bcc114b0ca5731217da8bba6ba39d1 AS compose-config
FROM ${VALHALLA_IMAGE}

USER root
RUN sed -i 's|^URIs:.*|URIs: https://snapshot.ubuntu.com/ubuntu/20261112T230000Z/|' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
    osmium-tool=1.16.0-1build1 \
    python3-pyosmium=3.7.0-1build1 \
    python3-pyproj=3.6.1-3build1 \
    sqlite3=3.45.1-1ubuntu2.9 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=compose-config /usr/local/bin/valhalla_build_config /opt/valhalla_build_config_compose
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN curl --fail --location --retry 3 --silent --show-error \
      https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar \
      -o /opt/planetiler.jar \
    && echo 'f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d  /opt/planetiler.jar' | sha256sum --check \
    && dpkg-query -W > /opt/offline-builder-packages.tsv
WORKDIR /work
ENTRYPOINT []
CMD ["bash"]
