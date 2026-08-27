FROM nginx:1.27-alpine

RUN apk add --no-cache apache2-utils nodejs

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint-basic-auth.sh /docker-entrypoint.d/10-basic-auth.sh
COPY docker-entrypoint-backend.sh /docker-entrypoint.d/20-backend.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/10-basic-auth.sh /docker-entrypoint.d/20-backend.sh \
    && chmod +x /docker-entrypoint.d/10-basic-auth.sh /docker-entrypoint.d/20-backend.sh

COPY server.js /app/server.js
COPY index.html /usr/share/nginx/html/index.html
COPY docs/ /usr/share/nginx/html/docs/

EXPOSE 8080
