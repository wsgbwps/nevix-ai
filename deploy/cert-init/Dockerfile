# Certificate initialization image for the official public deployment
# (issue #152, ADR-0013). The base is digest-pinned so the delivered image is
# reproducible from the repository tree; openssl is the only addition.
FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1

RUN apk add --no-cache openssl

COPY cert-init.sh /usr/local/bin/cert-init.sh
# The exec bit is enforced here so the repository checkout's file mode can
# never break the container start.
RUN chmod +x /usr/local/bin/cert-init.sh

ENTRYPOINT ["/usr/local/bin/cert-init.sh"]
