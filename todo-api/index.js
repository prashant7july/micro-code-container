const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const redis = require('redis');
var elasticsearch = require('elasticsearch');
const envProps = require('./env_props');

// MongoDB
const mongoClient = require('mongodb').MongoClient;
//const mongoObjectID = require('mongodb').ObjectID;
var db;
var usersCollection;
var mongoConnected = false;

// Initializing the Express Framework /////////////////////////////////////////////////////
const app = express();
const port = 8080;
app.use(bodyParser.json());
app.use(
    bodyParser.urlencoded({
        extended: true
    })
);

// Postgres Client Setup /////////////////////////////////////////////////////
const postgresClient = new Pool({
    host: envProps.postgresHost,
    port: envProps.postgresPort,
    database: envProps.postgresDatabase,
    user: envProps.postgresUser,
    password: envProps.postgresPassword,
    max: 10,                        // Max number of connections in the pool
    idleTimeoutMillis: 30000        // Connection timeout 30 seconds
});

// Redis Client Setup /////////////////////////////////////////////////////
const redisClient = redis.createClient({
    host: envProps.redisHost,
    port: envProps.redisPort,
    enable_offline_queue: false,
    retry_strategy: () => 1000 // try reconnecting after 1 sec.
});
redisClient.on('connect', () => console.log('Redis client connected'));
redisClient.on('error', (err) => console.log('Something went wrong with Redis: ' + err));

// Elasticsearch Client Setup ///////////////////////////////////////////////
const elasticClient = new elasticsearch.Client({
    hosts: [ envProps.elasticHost + ':' + envProps.elasticPort]
});
const TODO_SEARCH_INDEX_NAME = "todos";
const TODO_SEARCH_INDEX_TYPE = "todo";
// Ping the client to be sure Elastic is up
elasticClient.ping({
    requestTimeout: 30000,
}, function(error) {
    if (error) {
        console.error('Something went wrong with Elasticsearch: ' + error);
    } else {
        console.log('Elasticsearch client connected');

        // Check if todo index already exists?
        var todoIndexExists = elasticClient.indices.exists({
            index: TODO_SEARCH_INDEX_NAME
        }, function (error, response, status) {
            if (error) {
                console.log(error);
            } else {
                console.log('Todo index exists in Elasticsearch');
            }
        });


        if (!todoIndexExists) {
            // Create a Todos index. If the index has already been created, then this function fails safely
            elasticClient.indices.create({
                index: TODO_SEARCH_INDEX_NAME
            }, function (error, response, status) {
                if (error) {
                    console.log('Could not create Todo index in Elasticsearch: ' + error);
                } else {
                    console.log('Created Todo index in Elasticsearch');
                }
            });
        }
    }
});

// Set up the API routes /////////////////////////////////////////////////////

// Get all todos
app.route('/api/v1/todos').get( async (req, res) => {
    console.log('CALLED GET api/v1/todos');

    res.setHeader('Content-Type', 'application/json');

    // First, try get todos from cache (get all members of Set)
    await redisClient.smembers('todos', async (error, cachedTodoSet) => { //["Get kids from school","Take out the trash","Go shopping"]
        if (error) {
            console.log('  Redis get todos error: ' + error);
        }

        var todos = []; // [{"title":"Get kids from school"},{"title":"Take out the trash"},{"title":"Go shopping"}]
        if (cachedTodoSet == null || cachedTodoSet.length == 0) {
            // Nothing in cache, get from database
            postgresClient.connect((err, client) => {
                if (err) {
                    console.log('Could not connect to Postgres when getAllTodos: ' + err);
                } else {
                    console.log('Postgres client connected when getAllTodos');

                    client.query('SELECT title FROM todo', (error, todoRows) => {
                        if(error) {
                            throw error;
                        }
                        todos = todoRows.rows; // [{"title":"Get kids from school"},{"title":"Take out the trash"},{"title":"Go shopping"}]
                        console.log('  Got todos from PostgreSQL db: ' + todos);

                        if (todos != null && todos.length > 0) {
                            // Now, we got todos in the database but not in cache, so add them to cache
                            for (var i = 0; i < todos.length; i++) {
                                console.log('  Adding Todo: [' + todos[i].title + '] to Cache');
                                redisClient.sadd(['todos', todos[i].title], (error, reply) => {
                                    if (error) {
                                        throw error;
                                    }
                                });
                            }
                        }

                        res.send(todos);
                    });
                }
            });
        } else {
            for(var i = 0; i < cachedTodoSet.length; i++) {
                todos.push({"title": cachedTodoSet[i]});
            }
            console.log('  Got todos from Redis cache: ' + todos);
            res.send(todos);
        }
    });
});

// Create a new todo
app.route('/api/v1/todos').post( async (req, res) => {
    const todoTitle = req.body.title;

    console.log('CALLED POST api/v1/todos with title=' + todoTitle);

    // Insert todo in postgres DB
    postgresClient.connect((err, client) => {
        if (err) {
            console.log('Could not connect to Postgres in AddTodo: ' + err);
        } else {
            console.log('Postgres client connected in AddTodo');

            client.query('INSERT INTO todo(title) VALUES($1)', [todoTitle], (error, reply) => {
                if (error) {
                    console.log("Due to `title TEXT UNIQUE NOT NULL` UNIQUE if you are inter same data again and again")
                    throw error;
                }
                console.log('  Added Todo: [' + todoTitle + '] to Database');
            });

        }
    });

    // Update the Redis cache (add the todo text to the Set in Redis)
    await redisClient.sadd(['todos', todoTitle], (error, reply) => {
        if (error) {
            throw error;
        }
        console.log('  Added Todo: [' + todoTitle + '] to Cache');
    });

    // Update the search index
    await elasticClient.index({
        index: TODO_SEARCH_INDEX_NAME,
        type: TODO_SEARCH_INDEX_TYPE,
        body: { todotext: todoTitle }
    }, function(err, resp, status) {
        if (err) {
            console.log('Could not index ' + todoTitle + ": " + err);
        }
        console.log('  Added Todo: [' + todoTitle + '] to Search Index');
    });

    res.status(201).send(req.body)
});

// Search all todos
app.route('/api/v1/search').post(async (req, res) => {
    const searchText = req.body.searchText;

    console.log('CALLED POST api/v1/search with searchText=' + searchText);

    // Perform the actual search passing in the index, the search query and the type
    await elasticClient.search({
        index: TODO_SEARCH_INDEX_NAME,
        type: TODO_SEARCH_INDEX_TYPE,
        body: {
            query: {
                match: {
                    todotext: searchText
                }
            }
        }
    })
        .then(results => {
            console.log('Search for "' + searchText + '" matched: ' + results.hits.hits);
            res.send(results.hits.hits);
        })
        .catch(err=>{
            console.log(err);
            res.send([]);
        });
});

// Set up the health API/Users API routes /////////////////////////////////////////////////////
app.route('/health').get(async (req, res) => {
    var stat = {
        app: 'OK',
        mongo: mongoConnected
    };
    res.json(stat);
});

app.route('/api/v1/login').post(async (req, res) => {
    //req.log.info('login', req.body);
    console.info('login', req.body);
    if(req.body.name === undefined || req.body.password === undefined) {
        //req.log.warn('credentails not complete');
        console.info('credentails not complete');
        res.status(400).send('name or passowrd not supplied');
    } else if(mongoConnected) {
        usersCollection.findOne({
            name: req.body.name,
        }).then((user) => {
            //req.log.info('user', user);
            console.info('user', user);
            if(user) {
                if(user.password == req.body.password) {
                    res.json(user);
                } else {
                    res.status(404).send('incorrect password');
                }
            } else {
                res.status(404).send('name not found');
            }
        }).catch((e) => {
            //req.log.error('ERROR', e);
            console.error('ERROR', e);
            res.status(500).send(e);
        });
    } else {
        //req.log.error('database not available');
        console.error('database not available');
        res.status(500).send('database not available');
    }
});


// TODO - validate email address format
app.route('/api/v1/register').post(async (req, res) => {
    //req.log.info('register', req.body);
    console.log('register', req.body);
    if(req.body.name === undefined || req.body.password === undefined || req.body.email === undefined) {
        //req.log.warn('insufficient data');
        res.status(400).send('insufficient data');
    } else if(mongoConnected) {
        // check if name already exists
        usersCollection.findOne({name: req.body.name}).then((user) => {
            if(user) {
                //req.log.warn('user already exists');
                console.log('user already exists');
                res.status(400).send('name already exists');
            } else {
                // create new user
                usersCollection.insertOne({
                    name: req.body.name,
                    password: req.body.password,
                    email: req.body.email
                }).then((r) => {
                    //req.log.info('inserted', r.result);
                    console.info('inserted', r.result)
                    res.send('OK');
                }).catch((e) => {
                    //req.log.error('ERROR', e);
                    console.error('ERROR', e);
                    res.status(500).send(e);
                });
            }
        }).catch((e) => {
            //req.log.error('ERROR', e);
            console.error('ERROR', e);
            res.status(500).send(e);
        });
    } else {
        //req.log.error('database not available');
        console.error('database not available');
        res.status(500).send('database not available');
    }
});

// set up Mongo
// https://flaviocopes.com/node-mongodb/
function mongoConnect() {
    return new Promise((resolve, reject) => {
        //var mongoURL = process.env.MONGO_URL || 'mongodb://mongodb:27017/users';
        var mongoURL = process.env.MONGO_URL || 'mongodb://mongodb:27017';
        mongoClient.connect(mongoURL, {useNewUrlParser: true, useUnifiedTopology: true}, (error, client) => {
            if(error) {
                reject(error);
            } else {
                //db = _db;
                //Now you can select a database using the client.db() method
                const db = client.db('users');

                usersCollection = db.collection('users');
                resolve('connected');
            }
        });
    });
}

function mongoLoop() {
    mongoConnect().then((r) => {
        mongoConnected = true;
        console.log('MongoDB connected');
    }).catch((e) => {
        console.error('ERROR', e);
        setTimeout(mongoLoop, 2000);
    });
}

mongoLoop();


// Start the server /////////////////////////////////////////////////////
app.listen(port, () => {
    console.log('Todo API Server started!');
});