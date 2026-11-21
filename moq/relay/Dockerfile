# Sidecar MoQ: moq-relay (Luke Curley, github.com/moq-dev/moq) + su servidor de
# autenticación de referencia (`moq auth serve`). Binarios oficiales verificados
# por SHA-256; nada se compila aquí. Ver docs/ENGINE-MOQ.md.
FROM debian:trixie-slim
ARG MOQ_RELAY_VERSION=0.17.17
ARG MOQ_CLI_VERSION=0.14.17
ARG TARGETARCH=amd64
# SHA256SUMS de las releases moq-relay-v0.17.17 y moq-cli-v0.14.17
ARG RELAY_SHA_amd64=5ec139f090b66706f43e592f0a29e6cd0aa3b1865ab3a766dc37401827052339
ARG RELAY_SHA_arm64=4b43fcbeb49dcf80b25e5982794663b777067e17321f3020b286884e1026d161
ARG CLI_SHA_amd64=3480235295f45fa71c20a8222a18484b25cd9fe1a2ef664d72f7e8c430b1e24a
ARG CLI_SHA_arm64=b1823e6fce4335785ced40acd41988e7a7af6d764df46e28395a12a2e5c625b4
RUN set -eu; \
    case "$TARGETARCH" in amd64) A=x86_64; RS=$RELAY_SHA_amd64; CS=$CLI_SHA_amd64;; arm64) A=aarch64; RS=$RELAY_SHA_arm64; CS=$CLI_SHA_arm64;; *) echo "arch $TARGETARCH"; exit 1;; esac; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates curl; \
    base=https://github.com/moq-dev/moq/releases/download; \
    curl -fsSL -o /tmp/r.tgz "$base/moq-relay-v$MOQ_RELAY_VERSION/moq-relay-v$MOQ_RELAY_VERSION-$A-unknown-linux-gnu.tar.gz"; \
    echo "$RS  /tmp/r.tgz" | sha256sum -c -; \
    curl -fsSL -o /tmp/c.tgz "$base/moq-cli-v$MOQ_CLI_VERSION/moq-cli-v$MOQ_CLI_VERSION-$A-unknown-linux-gnu.tar.gz"; \
    echo "$CS  /tmp/c.tgz" | sha256sum -c -; \
    tar xzf /tmp/r.tgz -C /tmp; tar xzf /tmp/c.tgz -C /tmp; \
    install -m 0755 /tmp/moq-relay-v$MOQ_RELAY_VERSION-$A-unknown-linux-gnu/bin/moq-relay /usr/local/bin/moq-relay; \
    install -m 0755 /tmp/moq-cli-v$MOQ_CLI_VERSION-$A-unknown-linux-gnu/bin/moq /usr/local/bin/moq; \
    rm -rf /tmp/*; apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    useradd -r -u 10001 moq
COPY relay.toml /etc/moq/relay.toml
COPY entrypoint.sh /usr/local/bin/moq-entrypoint
RUN chmod 0755 /usr/local/bin/moq-entrypoint
EXPOSE 4433/udp
USER moq
ENTRYPOINT ["/usr/local/bin/moq-entrypoint"]
