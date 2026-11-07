# Mongo image for the isolated Coolify staging stack.
#
# Coolify's Compose parser materialises relative file bind-mounts as
# directories, so the helper scripts are baked into the image instead of being
# mounted at runtime. Production continues to use the existing mongo:8.0
# container and volume unchanged.
FROM mongo:8.0

COPY docker/mongo-start.sh /usr/local/bin/engage-mongo-start.sh
COPY docker/mongo-healthcheck.js /usr/local/bin/engage-mongo-healthcheck.js
COPY docker/mongo-init.js /docker-entrypoint-initdb.d/10-create-app-user.js

RUN chmod 0555 /usr/local/bin/engage-mongo-start.sh \
    && chmod 0444 /usr/local/bin/engage-mongo-healthcheck.js \
    && chmod 0444 /docker-entrypoint-initdb.d/10-create-app-user.js
