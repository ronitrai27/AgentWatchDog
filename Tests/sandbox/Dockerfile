# The Rox sandbox: every check runs in a container made from this image.
# Every tool is pinned, and the vulnerability databases and rules are baked in, so a run never
# downloads anything and can work with no network at all.
FROM node:26-bookworm-slim@sha256:3fcc4609776fc12c0079831ca6020e250ca109b8d46243d504625d0af7efda93

ARG GITLEAKS=8.30.1
ARG OSV=2.7.1
ARG TRIVY=0.76.2
ARG K6=2.4.0
ARG TOXIPROXY=2.13.0
ARG SEMGREP=1.187.0
ARG SCHEMATHESIS=4.34.2
ARG STRYKER=10.1.1
ARG SEMGREP_RULES=a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 python3-venv tini \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  gh=https://github.com; \
  curl -fsSL $gh/gitleaks/gitleaks/releases/download/v$GITLEAKS/gitleaks_${GITLEAKS}_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks; \
  curl -fsSL -o /usr/local/bin/osv-scanner $gh/google/osv-scanner/releases/download/v$OSV/osv-scanner_linux_amd64; \
  curl -fsSL $gh/aquasecurity/trivy/releases/download/v$TRIVY/trivy_${TRIVY}_Linux-64bit.tar.gz | tar -xz -C /usr/local/bin trivy; \
  curl -fsSL $gh/grafana/k6/releases/download/v$K6/k6-v$K6-linux-amd64.tar.gz | tar -xz --strip-components=1 -C /usr/local/bin k6-v$K6-linux-amd64/k6; \
  curl -fsSL -o /usr/local/bin/toxiproxy-server $gh/Shopify/toxiproxy/releases/download/v$TOXIPROXY/toxiproxy-server-linux-amd64; \
  curl -fsSL -o /usr/local/bin/toxiproxy-cli $gh/Shopify/toxiproxy/releases/download/v$TOXIPROXY/toxiproxy-cli-linux-amd64; \
  chmod 755 /usr/local/bin/*

RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir semgrep==$SEMGREP schemathesis==$SCHEMATHESIS
ENV PATH=/opt/py/bin:$PATH

RUN npm install -g --ignore-scripts @stryker-mutator/core@$STRYKER @stryker-mutator/vitest-runner@$STRYKER

# Semgrep rules from a fixed commit, plus Rox's own rules.
RUN mkdir -p /opt/rules/registry \
 && curl -fsSL https://github.com/semgrep/semgrep-rules/archive/$SEMGREP_RULES.tar.gz \
    | tar -xz -C /opt/rules/registry --strip-components=1 \
      semgrep-rules-$SEMGREP_RULES/javascript semgrep-rules-$SEMGREP_RULES/typescript \
 && find /opt/rules/registry -type f ! -name '*.yaml' ! -name '*.yml' -delete
COPY rules/ /opt/rules/rox/

# Vulnerability databases, downloaded now so a check never needs the network.
ENV TRIVY_CACHE_DIR=/opt/trivy \
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/opt/osv \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    XDG_CONFIG_HOME=/tmp \
    HOME=/tmp \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
RUN trivy fs --download-db-only --no-progress
RUN mkdir -p /tmp/seed \
 && printf '{"name":"seed","lockfileVersion":3,"packages":{"":{"name":"seed"},"node_modules/lodash":{"version":"4.17.20"}}}' > /tmp/seed/package-lock.json \
 && (osv-scanner scan source --offline-vulnerabilities --download-offline-databases -L /tmp/seed/package-lock.json || true) \
 && test -n "$(ls -A /opt/osv)" \
 && rm -rf /tmp/seed /tmp/.cache

# Only security rules: the registry also has style and translation rules, which are noise here.
RUN find /opt/rules/registry -type f \( -name '*.yaml' -o -name '*.yml' \) \
      -exec grep -L 'category: security' {} + | xargs -r rm -f \
 && echo "$(find /opt/rules/registry -type f | wc -l) security rule files kept"

# pnpm and Yarn (classic; a repo's own Yarn 2+ release in .yarn/releases is run by it), pinned.
RUN npm install -g --ignore-scripts pnpm@10.34.9 yarn@1.22.22

# Mount points owned by the sandbox user, so a new volume mounted there is writable by it.
RUN chmod -R a+rX /opt \
 && useradd --uid 10001 --create-home sandbox \
 && mkdir -p /src /work /base /agent /verify /out /cache \
 && chown 10001:10001 /src /work /base /agent /verify /out /cache \
 && printf 'gitleaks %s\nosv-scanner %s\ntrivy %s\nk6 %s\ntoxiproxy %s\nsemgrep %s\nschemathesis %s\nstryker %s\nsemgrep-rules %s\n' \
    $GITLEAKS $OSV $TRIVY $K6 $TOXIPROXY $SEMGREP $SCHEMATHESIS $STRYKER $SEMGREP_RULES > /opt/versions.txt

# The egress proxy for the dependency install (the only step allowed to reach a registry).
COPY egress-proxy.mjs chaos.mjs tools.mjs /opt/rox/

USER 10001
WORKDIR /src
ENTRYPOINT ["/usr/bin/tini", "--"]
