FROM node:18
RUN mkdir /app
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build:main
CMD ['/bin/node', 'index.js']
