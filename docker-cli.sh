#!/bin/bash

#stop / remove all of Docker containers
docker stop $(docker ps -a -q) && docker rm -f $(docker ps -a -q)

# docker rmi $(docker images -q)

# Remove volumes in Docker
# docker volume rm postgres-data
# docker volume rm elastic-data
docker volume rm $(docker volume ls -q)

# Used to store and restore database dumps
docker volume create --name postgres-data
docker volume create --name elastic-data

# Remove one or more networks
docker network rm todo-net

# create a shared network so the two or more containers can talk to each other
docker network create todo-net

# redis
docker run -d --network=todo-net --name=todo-redis -p 6379:6379 redis:5.0.3

# postgres
docker build -f ./todo-postgres/Dockerfile.dev -t todo-postgres:1.0 ./todo-postgres
docker run -d --network=todo-net --name=todo-postgres -v postgres-data:/var/lib/postgresql/data -e POSTGRES_USER=todo -e POSTGRES_PASSWORD=todo1234 -e POSTGRES_DB=todo -p 5432:5432 todo-postgres:1.0

# elastic
docker run -d --network=todo-net --name=todo-elastic -v elastic-data:/usr/share/elasticsearch/data -e discovery.type=single-node -p 9200:9200 -p 9300:9300 elasticsearch:6.6.1

# mongo
docker build -t todo-mongo:0.0.1 ./todo-mongo

# docker run --name=todo-mongo -d --network=todo-net -p 27017:27017 todo-mongo:0.0.1
docker run \
  --name=todo-mongo \
  -d \
  --network=todo-net \
  -p 27017:27017 \
  todo-mongo:0.0.1

# api
docker build -f ./todo-api/Dockerfile.dev -t todo-api:1.0 ./todo-api
docker run -d \
    --network=todo-net \
    --name=todo-api \
    -p 8088:8080 \
    -e POSTGRES_HOST=todo-postgres \
    -e POSTGRES_PORT=5432 \
    -e POSTGRES_DATABASE=todo \
    -e POSTGRES_USER=todo \
    -e POSTGRES_PASSWORD=todo1234 \
    -e REDIS_HOST=todo-redis \
    -e REDIS_PORT=6379 \
    -e ELASTICSEARCH_HOST=todo-elastic \
    -e ELASTICSEARCH_PORT=9200 \
    -e MONGO_URL=mongodb://todo-mongo:27017 \
    todo-api:1.0 \
    sh /app/start.sh

# create a shared network
docker network inspect todo-net

# Front End
curl -X GET http://localhost:8088/api/v1/todos

# MongoDB Health
curl -X GET http://localhost:8088/health

# Register API Curl Command -
curl -X POST http://localhost:8088/api/v1/register -H 'content-type: application/json' -d '{"name": "Prashant", "email": "prashant7july@gmail.com", "password": "asjdhgad123"}'