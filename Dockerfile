FROM nginx:1.27-alpine

RUN apk add --no-cache apache2-utils

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint-basic-auth.sh /docker-entrypoint.d/10-basic-auth.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/10-basic-auth.sh \
    && chmod +x /docker-entrypoint.d/10-basic-auth.sh

COPY index.html /usr/share/nginx/html/index.html
COPY docs/ /usr/share/nginx/html/docs/

EXPOSE 8080
