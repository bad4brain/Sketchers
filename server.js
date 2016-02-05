var app = require('http').createServer(handler),
	io = require('socket.io').listen(app, { log: false }),
	fs = require('fs'),
	sanitizer = require('sanitizer'),
	port = process.env.port || 42420;

app.listen(port);
console.log('>>> Sketchers started on port ' + port + ' >>>');

// ================================================
// server routing
// ================================================

function handler (req, res) {
	var reqFile = req.url;
	
	// default file
	if (reqFile == '/') {
		reqFile = '/index.html';
	}
	
	// file exists?
	try {
		fs.lstatSync(__dirname + '/client' + reqFile);
	}
	catch (e) {
		reqFile = '/404.html';
	}
	
	// show file
	fs.readFile(__dirname + '/client' + reqFile,
		function (err, data) {
			if (err) {
				res.writeHead(200);
				return res.end('Error loading requested file ' + reqFile);
			}
			
			var filetype = reqFile.substr(reqFile.lastIndexOf('.'));
			switch(filetype) {
				case '.html':
					res.setHeader('Content-Type', 'text/html');
					break;
				case '.js':
					res.setHeader('Content-Type', 'application/javascript');
					break;
				case '.css':
					res.setHeader('Content-Type', 'text/css');
					break;
				case '.gif':
					res.setHeader('Content-Type', 'image/gif');
					break;
				case '.png':
					res.setHeader('Content-Type', 'image/png');
					break;
			}
			
			res.writeHead(200);
			res.end(data);
		}
	);
}

// ================================================
// app logic
// ================================================

var users = [], canvas = [];
var dictionary, currentWord = null, currentPlayer = null; 
var drawingTimer = null, hintIntervalId = null;
var playerUID = 1;
var roundStartTime;
var socketsById = {}, usersById = {};
var currentHint, numCurrentHintsProvided;
var disconnectedUserScores = {};

// game mode
var roundTime = 120, roundNo = 0;
var correctGuessEndsTurn = false;
var scoreByRemainingTime = true; // if false, score constant
var autoSelectNextPlayer = true; // if false, players must manually select the next player
var maxHints = 4;
var maxHintFraction = 0.40;
var timeBetweenRounds = 7; // seconds

function shuffle(array) {
	  var currentIndex = array.length, temporaryValue, randomIndex;

	  // While there remain elements to shuffle...
	  while (0 !== currentIndex) {

	    // Pick a remaining element...
	    randomIndex = Math.floor(Math.random() * currentIndex);
	    currentIndex -= 1;

	    // And swap it with the current element.
	    temporaryValue = array[currentIndex];
	    array[currentIndex] = array[randomIndex];
	    array[randomIndex] = temporaryValue;
	  }
}

// load dictionary.txt into memory
fs.readFile(__dirname + '/dictionaries/de.txt', function (err, data) {
	dictionary = data.toString('utf-8').split('\r\n');
	dictionary = dictionary.map(function(x) {
		return x.split(",");
	});
	dictionary = dictionary.filter(function(x) { return x.length == 3; });
	console.log(dictionary.length + " words in dictionary");
	shuffle(dictionary);
});

io.sockets.on('connection', function (socket) {
	var myNick = 'Player' + playerUID++,
		myColor = rndColor();
		myScore = 0;
		
	socketsById[socket.id] = socket;
	
	function getRandomInt(min, max) {
	    return Math.floor(Math.random() * (max - min + 1)) + min;
	}
	
	function addHint() {
		var indices = [];
		for (var i = 0; i < currentHint.length; ++i)
			if (currentHint[i] == '_')
				indices.push(i);
		if (indices.length > 0) {
			var idx = indices[getRandomInt(0, indices.length-1)];
			currentHint = currentHint.substr(0, idx) + currentWord[idx] + currentHint.substr(idx+1);
			++numCurrentHintsProvided;
		}
	}
	
	function provideHint() {
		addHint();
		io.sockets.emit('hint', {hint: currentHint});
	}
	
	function emitUsers() {
		io.sockets.emit('users', sortedUsers());
	}
	
	function startTurn(playerId) {
		roundNo++;
		console.log("Round #" + roundNo);
		
		currentPlayer = playerId;
		var user = usersById[playerId];
		if (!user) {
			console.error('Found no user for id ' + playerId);
			return;
		}
		
		canvas.splice(0, canvas.length);
		io.sockets.emit('clearCanvas');
		
		var word = dictionary[(roundNo-1) % dictionary.length];
		
		currentWord = word[0];

		// initialise hint
		var hint = '';
		var nonHint = '- ';
		for (var i = 0; i < currentWord.length; ++i) {
			if (nonHint.indexOf(currentWord[i]) === -1) {
				hint += '_';
			}
			else {
				hint += currentWord[i];
			}
		}
		numCurrentHintsProvided = 0;
		currentHint = hint;
		
		// add one hint from the start
		//addHint();
		
		// determine the maximum number of additional hints to provide
		var maxHintsForWord = Math.floor(currentWord.length * maxHintFraction);
		var hintsToProvideInTotal = Math.min(maxHints, maxHintsForWord);
		var hintsYetToProvide = hintsToProvideInTotal - numCurrentHintsProvided;
		var hintInterval = 1000 * (roundTime / (hintsYetToProvide+1));

		// reset user data
		users.map(function(u) {
			u.isCurrent = u.id == user.id;
			u.guessedCorrectly = false;
			u.scoreCurrentRound = undefined;
		});
		
		// send messages
		socketsById[playerId].emit('youDraw', word);
		io.sockets.emit('startRound', { color: user.color, nick: user.nick, time:roundTime, hint:currentHint });
		emitUsers();
		
		// set the timers for this round
		drawingTimer = setTimeout(turnFinished, roundTime * 1000);
		hintIntervalId = setInterval(provideHint, hintInterval);
		roundStartTime = new Date().getTime();
	}
	
	socket.on('join', function(msg) {
		if (msg.nick) {
			myNick = sanitizer.sanitize(msg.nick);
		}
		if (myNick == '')
			return;
		if (msg.color)
			myColor = msg.color;
		
		if (usersById[socket.id]) {
			console.log('Duplicate join attempted by ' + usersById[socket.id].nick);
			return;
		}
		
		// add user
		if (disconnectedUserScores[myNick]) {
			myScore = disconnectedUserScores[myNick];
			delete disconnectedUserScores[myNick];
		}
		var user = { id: socket.id, nick: myNick, color: myColor, score: myScore, guessedCorrectly:false, isCurrent:false };
		users.push(user);
		usersById[socket.id] = user;
		console.log('Player joined: id=' + socket.id + ', nick=' + msg.nick + ', users.length=' + users.length);
		socket.emit('joined');
		io.sockets.emit('userJoined', { nick: myNick, color: myColor });
		emitUsers();
		socket.emit('drawCanvas', canvas);
		
		// notify if someone is drawing
		if(currentPlayer) {
			currentUser = usersById[currentPlayer];
			if (currentUser) {
				var timePassedSecs = Math.floor((new Date().getTime() - roundStartTime) / 1000);
				socket.emit('startRound', { color: currentUser.color, nick: currentUser.nick, time: roundTime-timePassedSecs, hint:currentHint });
			}
		}
	});
	
	var checkForEndOfRound = function() {
		var doneUsers = users.filter(function(u) { return u.guessedCorrectly; });
		var numGuessed = doneUsers.length;
		var allGuessed = numGuessed == users.length-1; 
		if ((numGuessed > 0 && correctGuessEndsTurn) || allGuessed) {
			turnFinished(false, allGuessed);
		}
	};
	
	socket.on('message', function (msg) {
		var sanitizedMsg = sanitizer.sanitize(msg.text);
		if(sanitizedMsg != msg.text) {
			console.log('(!) Possible attack detected from ' + socket.id + ' (' + myNick + ') : ' + msg.text);
		}
		if(!sanitizedMsg || sanitizedMsg.length>256) {
			return;
		}
		
		var isCorrectGuess = currentWord && sanitizedMsg.toLowerCase().trim() == currentWord.toLowerCase();
		
		if (!isCorrectGuess)
			io.sockets.emit('message', { text: sanitizedMsg, color: myColor, nick: myNick });
		
		// check if current word was guessed by a player who isn't the drawing player while the round is active
		if (isCorrectGuess && currentPlayer != null && currentPlayer != socket.id) {
			var user = usersById[socket.id];
			// ... and the user did not previously guess the word
			if(user && !user.guessedCorrectly) {
				var timePassed = new Date().getTime() - roundStartTime;
				var timePassedSecs = Math.floor(timePassed / 1000);
				var timeRemainingSecs = roundTime - timePassedSecs;
				
				// award points
				var pointsAwarded = [];
				// * guessing player
				var points; 
				if (scoreByRemainingTime) 
					points = timeRemainingSecs;
				else
					points = 10;
				user.score += points;
				user.scoreCurrentRound = points;
				user.guessedCorrectly = true;
				pointsAwarded.push([user, points]);
				// * drawing player
				var drawingUser = usersById[currentPlayer];
				if (scoreByRemainingTime)
					points = Math.floor(timeRemainingSecs / (users.length-1));
				else
					points = 10;
				drawingUser.score += points;
				if (!drawingUser.scoreCurrentRound) drawingUser.scoreCurrentRound = 0;
				drawingUser.scoreCurrentRound += points;
				pointsAwarded.push([drawingUser, points]);
				
				io.sockets.emit('wordGuessed', { timePassedSecs: timePassedSecs, color: myColor, nick: myNick, points: pointsAwarded });
				socket.emit('youGuessedIt');
				
				// communicate new scores
				emitUsers();
				
				checkForEndOfRound();
			}
		}
	});
	
	socket.on('nickChange', function (user) {
		var sanitizedNick = sanitizer.sanitize(user.nick);
		if(sanitizedNick != user.nick) {
			console.log('(!) Possible attack detected from ' + socket.id + ' (' + myNick + ') : ' + user.nick);
		}
		if(!sanitizedNick || myNick == sanitizedNick || sanitizedNick.length>32 ) {
			return;
		}
		
		io.sockets.emit('nickChange', { newNick: sanitizedNick, oldNick: myNick, color: myColor });
		myNick = sanitizedNick;
		
		for(var i = 0; i<users.length; i++) {
			if(users[i].id == socket.id) {
				users[i].nick = myNick;
				break;
			}
		}
		
		emitUsers();
	});
	
	socket.on('disconnect', function () {
		console.log('socket disconnected: ' + socket.id);
		delete socketsById[socket.id];
		var user = usersById[socket.id];
		if (user) {
			console.log('user disconnected: nick=' + user.nick);
			disconnectedUserScores[user.nick] = user.score;
			delete usersById[socket.id];		
			users.splice(users.indexOf(user), 1);
			io.sockets.emit('userLeft', { nick: myNick, color: myColor });
			emitUsers();
			if(currentPlayer == socket.id) {
				turnFinished();
			}
			else {
				checkForEndOfRound();
			}
		}
	});
	
	socket.on('draw', function (line) {
		if(currentPlayer == socket.id) {
			canvas.push(line);
			socket.broadcast.emit('draw', line);
		}
	});
	
	socket.on('clearCanvas', function () {
		console.log('received clearCanvas');
		if(currentPlayer == socket.id) {
			console.log('clearCanvas from current player can be processed');
			canvas.splice(0, canvas.length);
			io.sockets.emit('clearCanvas');
		}
	});
	
	socket.on('changeNickColor', function() {
		myColor = rndColor();
		
		for(var i = 0; i<users.length; i++) {
			if(users[i].id == socket.id) {
				users[i].color = myColor;
				break;
			}
		}
		
		emitUsers();
	});
	
	function rndColor() {
		var color = '#'+(0x1000000+(Math.random())*0xffffff).toString(16).substr(1,6);
		return color;
	};
	
	function sortedUsers() {
		var theUsers = users.slice();
		theUsers.sort(function(a,b) { return parseFloat(b.score) - parseFloat(a.score); } );
		return theUsers;
	}
	
	socket.on('readyToDraw', function () {
		console.log('ready: id=' + socket.id);
		if (!currentPlayer) { // new round triggered
			console.log('ready: player ' + socket.id);
			startTurn(socket.id);
		} else if (currentPlayer == socket.id) { // pass
			// turn off drawing timer
			turnFinished(true);
		}
	});
	
	function turnFinished(opt_pass, opt_allGuessed) {
		console.log('turn finished: users.length=' + users.length);
		var drawingPlayerIndex = 0;
		for(; drawingPlayerIndex < users.length; drawingPlayerIndex++)
			if (users[drawingPlayerIndex].id == currentPlayer) 
				break;
		console.log('turn finished; player index: ' + drawingPlayerIndex + '; current player ID: ' + currentPlayer);
		
		if (drawingTimer != null) {
			clearTimeout(drawingTimer);
			drawingTimer = null;
		}
		if (hintIntervalId != null) {
			clearTimeout(hintIntervalId);
			hintIntervalId = null;
		}
		
		currentPlayer = null;
		var nextPlayer = users[(drawingPlayerIndex+1) % users.length];
		
		io.sockets.emit('endRound', { 
			word: currentWord, isPass: opt_pass, allGuessed: opt_allGuessed, 
			timeUntilNextRound: autoSelectNextPlayer ? timeBetweenRounds : undefined,
			nextPlayer: nextPlayer});
	
		// allow next user to draw
		if (autoSelectNextPlayer) {
			console.log('Waiting ' + timeBetweenRounds + ' seconds to start next round');
			setTimeout(function() {
					nextPlayer = users[(drawingPlayerIndex+1) % users.length];
					console.log('drawingPlayerIndex=' + drawingPlayerIndex + ', users.length=' + users.length);
					if (nextPlayer == undefined)
						console.log("no user");
					else {
						console.log('turn finished; new player ID: ' + nextPlayer.id);
						startTurn(nextPlayer.id);
					}
				}, timeBetweenRounds*1000);
		}
		else {
			currentPlayer = null;
			io.sockets.emit('youCanDraw');
		}
	}
});