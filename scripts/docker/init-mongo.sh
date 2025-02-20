#!/bin/bash
set -e

# Handle cleanup on script exit
cleanup() {
    echo "Shutting down MongoDB..."
    # Use docker stop for a cleaner shutdown
    exit 0
}
trap cleanup SIGTERM SIGINT

# Start MongoDB without replica set configuration
mongod --bind_ip_all --dbpath /data/db &
MONGOD_PID=$!

# Wait for MongoDB to be ready
MAX_TRIES=30
COUNTER=0
echo "Waiting for MongoDB to start..."
until mongosh --eval "db.adminCommand('ping')" >/dev/null 2>&1; do
    if [ $COUNTER -gt $MAX_TRIES ]; then
        echo "Error: MongoDB failed to start"
        kill $MONGOD_PID # Ensure mongod is stopped
        exit 1
    fi
    let COUNTER=COUNTER+1
    sleep 1
done

echo "MongoDB started in standalone mode."

# Keep container running
wait $MONGOD_PID