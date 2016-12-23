var botBuilder = require('claudia-bot-builder');
var request = require('request');
var Promise = require('bluebird');
var cheerio = require('cheerio');
var Dynamite = require('dynamite');
var lambda = require('aws-lambda-invoke');

var AWS = require('aws-sdk');
require('dotenv').config();
var S = require('string');
var redis = require("redis");


if (process.env.AWS_REGION) {
    AWS.config.update( { region: process.env.AWS_REGION } );
}

//Declare all constants and variables here.
var userID = null;
var registeredUser = false;
var processingExpecting = false;
const AccessToken = process.env.ACCESS_TOKEN;
const RedisURL = process.env.REDIS_URL;
const RedisPassword = process.env.REDIS_PASSWORD;
const AMSDomain = process.env.AMS_DOMAIN;
const AMSStudentPageUrl = AMSDomain + process.env.AMS_STUDENT_PAGE_URL;
const AppFBPageID = process.env.APP_FB_PAGE_ID;
const DDBTable = process.env.DYNAMODB_TABLE;
const DDBHashKey = process.env.DYNAMODB_HASH_KEY;
const LambdaFunctionName = process.env.LAMBDA_FUNCTION_NAME;

var dbclient = new Dynamite.Client({region: process.env.AWS_REGION});
const fbTemplate = botBuilder.fbTemplate;

Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

var rClient = redis.createClient({
	url : RedisURL,
	password : RedisPassword
});

//TODO: Not really required since Claudia updated with new templates.
const SENDERACTIONS = {
	MARK_SEEN: "mark_seen",
	TYPING_OFF: "typing_off",
	TYPING_ON: "typing_on"
}

const RESPONSETEMPLATE = {
	CREDENTIAL_OPTION : "credential_option",
	CREDENTIAL_OPTION_RETRY : "credential_option_retry",
	MAIN_MENU : "main_menu"
}

/*
	Use this function to set the 'processing' variable true or false.
	If it's true, it means that the bot is still processing the last request of the user.
	In case a user sends a message and bot is still processing, it can throw an error to user to avoid sending messages.
*/
var iAmProcessing = function(op) {
	var data = '0';
	if(op === true){
		data = '1';
	}
	rClient.hset(userID, 'processing', data);
}

/*
	Sends a text message to Messenger. Only requires message as argument.
	TODO:Needs testing.
*/
var sendTextMessage = function(message) {
	
	return new Promise(function(resolve, reject){
		
		var body = {};
		body.recipient = {id:userID};
		body.message = {text:message};

		resolve(sendToMessenger(body));
	});
}

/*
	An almost low level function to send to Messenger any messages like text or chat actions.
	TODO:Needs testing.
*/
var sendToMessenger = function(body) {
	return new Promise(function(resolve, reject){

		var link = "https://graph.facebook.com/v2.6/me/messages?access_token=" + AccessToken;
		var headers = {'Content-Type': 'application/json'};

		var options = {url:link, headers: headers, body:JSON.stringify(body)};
		
		request.post(options, function(err, res, body){
			resolve();
		});
	});
}

/*
	Brings the information of user from database, parses them and then return it in required format.
*/
var showMarks = function(userData) {
	return new Promise(function(resolve, reject){

		var crawlData = userData;

		var newMsg = new fbTemplate.List('compact');
		var dueList = new fbTemplate.List('compact');
		var numOfSems = crawlData.marks.length;

		var userMarks = {};

		try {
			for(var i=0;i<=numOfSems-1;i++){

				var numOfSubjects = crawlData.marks[i].length;
				for(var a=0;a<=numOfSubjects-1;a++){

					var subjectName = crawlData.marks[i][a].name;
					var subjectCode = crawlData.marks[i][a].code;
					var subjectMarks = crawlData.marks[i][a].marks;

					console.log(subjectMarks + subjectCode + subjectName);

					try {
						userMarks[subjectName].push(subjectMarks);
					} catch (error) {
						userMarks[subjectName] = [];
						userMarks[subjectName].push(subjectMarks);
					}
					
				}
			}

			console.log(JSON.stringify(userMarks));

			var numOfSubjects = Object.keys(userMarks).length;

			var currentNum = 0;

			for (var key in userMarks) {
				if (userMarks.hasOwnProperty(key)) {
					if(currentNum >= 4){
						dueList.addBubble(key, "Marks - " + userMarks[key].join(', '));
					} else {
						newMsg.addBubble(key, "Marks - " + userMarks[key].join(', '));
					}

					console.log(key);
					console.log(currentNum);
					console.log(numOfSubjects-1);

					if(currentNum >= numOfSubjects-1) {
						rClient.hset(userID, 'more_subject_marks', JSON.stringify(dueList.get()));
					}
					currentNum++;
				}
			}
			
		} catch (error) {
			console.log("Error from loop " + error);
		}

		console.log(JSON.stringify(dueList.get()));
		
		newMsg.addListButton('More...', 'more_subject_marks');
		
		//iAmProcessing(false);
		return resolve(newMsg.get());
	});
}

/*
	Brings the attendance information of user from database, parses them and then return it in required format.
*/
var showAttendance = function(userData) {
	return new Promise(function(resolve, reject){

		var crawlData = userData;

		var newMsg = new fbTemplate.List('compact');
		var dueList = new fbTemplate.List('compact');
		var numOfSubjects = crawlData.attendance.length;
		
		try {
			for(var i=0;i<=numOfSubjects-1;i++){
				var subjectName = crawlData.attendance[i].name;
				var subjectAtten = crawlData.attendance[i].attendance;

				if(i >= 4 && i <= numOfSubjects-1){
					dueList.addBubble(subjectName, "Attendance - " + subjectAtten + "%");
				} else {
					newMsg.addBubble(subjectName, "Attendance - " + subjectAtten + "%");
				}

				if(i >= numOfSubjects-1) {
					rClient.hset(userID, 'more_subject_attendance', JSON.stringify(dueList.get()));
				}
				
				console.log(subjectName + " - " + subjectAtten);
				
			}
		} catch (error) {
			console.log("Error from loop " + error);
		}
		
		newMsg.addListButton('More...', 'more_subject_attendance');
		
		//iAmProcessing(false);
		return resolve(newMsg.get());

	});
}

/*
	Returns the required JSON template required by the FB Messenger.
*/
var getResponseTemplate = function(templateType, extraData) {
	if(templateType === RESPONSETEMPLATE.CREDENTIAL_OPTION) {
		var newMsg = new fbTemplate.Button('We need your credentials to log in on AMS.' + 
		'\nPlease select preferred option.\n\n' +
		'PS - It\'s a one time process :)');
		newMsg.addButton('Student ID & DOB', 'regbirth');
		newMsg.addButton('Username & Password', 'userpass');
		return newMsg.get();
	}
	else if(templateType === RESPONSETEMPLATE.CREDENTIAL_OPTION_RETRY){
		var newMsg = new fbTemplate.Button('Looks like you have submitted incorrect credentials :( \nPlease try again.' + 
		'\n\nSelect preferred login option.');
		newMsg.addButton('Student ID & DOB', 'regbirth');
		newMsg.addButton('Username & Password', 'userpass');
		newMsg.addButton('Cancel login process', 'cancel_login');
		return newMsg.get();
	}
	else if(templateType === RESPONSETEMPLATE.MAIN_MENU && extraData !== null) {
		var newMsg = new fbTemplate.Button('Hey, ' + extraData.name + '! :) \nWhat would you like to do?');
		newMsg.addButton('Check Attendance', 'attendance');
		newMsg.addButton('Check Marks', 'marks');
		//newMsg.addButton('More options...', 'options');
		return newMsg.get();
	}
	else if(templateType === RESPONSETEMPLATE.MAIN_MENU) {
		var newMsg = new fbTemplate.Button('What would you like to do?');
		newMsg.addButton('Check Attendance', 'attendance');
		newMsg.addButton('Check Marks', 'marks');
		//newMsg.addButton('More options...', 'options');
		return newMsg.get();
	}
}

/*
	Gets the data of latest semester of the user. For getting the profile of user, see the getUserProfile function.
*/
var getUserData = function() {
	return new Promise(function(resolve, reject){
		dbclient.getItem(DDBTable)
				.setHashKey(DDBHashKey, userID)
				.execute()
				.then(function(data) {
					
					if(data.result && data.result.latest_sem){
						/*
							Update the profile on cache so that it is not called again.
						*/
						console.log("Nope, I am not 2nd");
						return resolve(JSON.parse(data.result.latest_sem));
						
					} else {
						//console.log("Error occured " + err);
						reject('No user like that');
					}
				}).fail(function(err){
			console.log("Error occured " + err);
			reject('No user like that');
		});
	});
}

/*
	Gets the profile of the user. For getting the data of user, see the getUserData function.
*/
var getUserProfile = function() {

	return new Promise(function(resolve, reject){

		rClient.hgetAsync(userID, 'profile').then(function(data){
			console.log("First is " + data);
			if(data !== null){
				console.log("Redis data is " + typeof(data));
				try {
					return resolve(JSON.parse(data));
				} catch (error) {
					//Carry on?
				}
			}

			dbclient.getItem(DDBTable)
				.setHashKey(DDBHashKey, userID)
				.execute()
				.then(function(data) {
					
					if(data.result && data.result.profile){
						/*
							Update the profile on cache so that it is not called again.
						*/
						console.log("Nope, I am not");
						rClient.hsetAsync(userID, 'profile', data.result.profile).then((vd) => {
							return resolve(JSON.parse(data.result.profile));
						});
						
					}
					else{
						console.log("I am in conditon)");
						request('https://graph.facebook.com/v2.6/' + userID + '?access_token=' + AccessToken, function(err, res, body){
							if (!err && res.statusCode == 200) {
								console.log("Data is " + typeof(body));
								console.log(body);
								//resolve(JSON.parse(body));
								dbclient.newUpdateBuilder(DDBTable)
								.setHashKey(DDBHashKey, userID)
								.putAttribute('profile', body).execute().then(function(ds){
									rClient.hsetAsync(userID, 'profile', body);
								}).fail(function(err){
									console.log("dbb err " + err);
								});
								return resolve(JSON.parse(body));
							}
							else{
								reject("Some error occured while fetching the user details.");
							}
						});
					}
				}).fail(function(err){
			console.log("Error occured " + err);
			reject('No user like that');
		});

		});

	});

}

/*
	Checks if the given credential is correct or not.
	TODO:Not required anymore. Directly we use the other lambda function.
*/
var verifyCredentials = function(username, password, ctype) {

	return new Promise(function(resolve, reject){
		var options = {};
		if(ctype === "dob") {
			options.url = AMSDomain + "/websis/control/viewStudentProfile";
			options.form = {birthDate_i18n : username, idValue : password};
		}
		else {
			options.url = AMSDomain + "/sis/control/viewStudentProfile";
			options.form = {USERNAME : username, PASSWORD : password};
		}

		request(options, function(err, res, body){
			if(!err && res.statusCode === 200) {
				$ = cheerio.load(body);
				var title = $('title').text().toLowerCase();
				console.log(title);
				if(S(title).contains('login')){
					console.log("it is login");
					return resolve(false);
				}
				if(S(title).contains('view')){
					console.log("its okay");
					return resolve(true);
				}
			}
		});
	});

}

/*
	Checks whether the bot is expecting anything (like username or password) from the user.
*/
var expectingFromUser = function() {
	processingExpecting = true;
	
	return new Promise(function(resolve, reject){
		rClient.hgetAsync(userID, 'expecting').then(function(data){
			console.log(data);
			console.log(typeof(data));
			return resolve(data);
		}).catch(function(err){
			console.log("Are we talking about this error?");
		});
	});
	
}

/*
	Starts the process of crawling the AMS and logs in on behalf of the user.
*/
var startLoginProcess = function(data){
	return new Promise(function(resolve, reject){

		var lambdaPara = data;

		lambda.invoke(LambdaFunctionName, lambdaPara).then(result => {
			console.log('Received the result from Lambda crawler function.\n' + result);
			resolve(result);
		}).catch(function(err){
			console.log('Login with error' + err);
			reject('Sorry mate. Unable to login :(');
		});
	});
}

/*
	Checks in database whether the current user is registered or not.
	TODO:Not required anymore.
*/
var isUserRegistered = function(){
	return new Promise(function(resolve, reject){

			rClient.hgetAsync(userID, 'is_registered').then(function(res){
				if(res === "1") {
					return resolve(true);
				}
				if(res === null) {
					dbclient.getItem(DDBTable)
					.setHashKey(DDBHashKey, userID)
					.execute()
					.then(function(data){
						if(data.result && data.result.is_registered){
							if(data.result.is_registered == true){
								rClient.hsetAsync(userID, 'is_registered', "1");
								return resolve(true);
							}
							else {
								return reject(false);
							}
						}else {
							return reject(false);
						}
						
					});
				}
			});

	});
}

module.exports = botBuilder(function (req) {

	/*
	TODO:If we are testing a new version, then all the request should be redirected to the new function.
	And also, if we as a human want to take over the conversation, it should happen too.
	*/

	return new Promise(function(resolve, reject){

		console.log(JSON.stringify(req));

		userID = req.originalRequest.sender.id;
		registeredUser = isUserRegistered();

		if(userID === AppFBPageID){
			console.log("Cannot do anything");
			//return resolve(acknowledgeMessage(SENDERACTIONS.MARK_SEEN));
		}

		/*
			TODO: Make the processing function work.
		*/
		rClient.hgetAsync(userID, 'processing').then(function(res){
			if(res === "1"){
				//return resolve("I am processing the previous message. Please wait? 🙄");
			}
			else {
				//iAmProcessing(true);
			}
		});
		
		var message = req.text;

		var postback = false;

		if(req.hasOwnProperty("postback")){
			postback = req.postback;
		}

		
		console.log("post back is " + postback);

		/*
			Checks if the message from Messenger is a postback or a simple message.
			Goes in this condition to process the postback.
		*/
		if(postback === true) {
			
			//When user asks for 'Check Attendance'.
			if(message === "attendance"){

				getUserData().then(function(userData){
					return resolve(showAttendance(userData));
				}).catch((err) => {
					console.log("In attendance error - " + err);
					iAmProcessing(false);
					rClient.hset(userID, 'due_action', message);
					return resolve(getResponseTemplate(RESPONSETEMPLATE.CREDENTIAL_OPTION, null));
				});
			//	return resolve("To get your attendance data from AMS we require your ");
			}

			//User asks for 'Check Marks'
			if(message === "marks") {
				getUserData().then(function(userData){
					return resolve(showMarks(userData));
				}).catch((err) => {
					iAmProcessing(false);
					rClient.hset(userID, 'due_action', message);
					return resolve(getResponseTemplate(RESPONSETEMPLATE.CREDENTIAL_OPTION, null));
				});
			}

			//User selects the Username/Password as preferred method to login.
			if(message === "userpass") {

				rClient.hsetAsync(userID, 'expecting', 'username').then(function(res){
					console.log(res);
					var newMsg = new fbTemplate.Text("Please provide your username in reply.");
					newMsg.addQuickReply('Cancel login', 'cancel_login');
					iAmProcessing(false);
					return resolve(newMsg.get());
				});
			}

			//User cancels the login process.
			if(message === "cancel_login"){
				rClient.delAsync(userID).then(function(){
					getUserProfile().then(function(userData){
						var newMsg = new fbTemplate.Button('Oh. No issues, ' + userData.first_name + ' :)\nYou can come back anytime to login again. \n\nWhat would you like to do then?');
						newMsg.addButton('Check Attendance', 'attendance');
						newMsg.addButton('Check Marks', 'marks');
						newMsg.addButton('More options...', 'options');
						iAmProcessing(false);
						return resolve(newMsg.get());
					});
				});
			}

			//User selects Student ID + DOB as preferred login method.
			if(message == "regbirth"){
				rClient.hsetAsync(userID, 'expecting', 'studentid').then(function(res){
					console.log(res);
					var newMsg = new fbTemplate.Text("Please reply with your Student ID (Registration ID).");
					newMsg.addQuickReply('Cancel login', 'cancel_login');
					iAmProcessing(false);
					return resolve(newMsg.get());
				});
			}

			//User asks for more subject attendance.
			if(message === "more_subject_attendance") {
				rClient.hgetAsync(userID, 'more_subject_attendance').then(function(dueList){
					console.log(dueList);
					rClient.hdel(userID, 'more_subject_attendance');
					return resolve(JSON.parse(dueList));
				});
			}

			//User ask for more subject marks.
			if(message === "more_subject_marks") {
				rClient.hgetAsync(userID, 'more_subject_marks').then(function(dueList){
					console.log(dueList);
					rClient.hdel(userID, 'more_subject_marks');
					return resolve(JSON.parse(dueList));
				});
			}
		}

		/*
			Regardless of the message containing a postback or not, the function will check whether we are expecting something
			from the user or not.
			TODO:Is it safe way?
		*/
		expectingFromUser().then(function(data){

			//Condition when user provides Username.
			if(data === "username" && postback === false) {
				//Save username. Expect password.
				var username = S(message).trim();

				rClient.hmsetAsync(userID, ['expecting', 'password', 'temp_username', username]).then(function(res){
					var newMsg = new fbTemplate.Text("Please provide your password in reply.\n\nDon't feel like sharing password?\nLogin with Student ID instead. :)");
					newMsg.addQuickReply('Login with ID & DOB', 'regbirth');

					//TODO:Give user a quick reply with Password.

					/*if(username.split('@').length == 2) {
						var newPass = username.split('@');
						newMsg.addQuickReply(newPass[1], newPass[1]);
					}*/

					newMsg.addQuickReply('Cancel login', 'cancel_login');
					iAmProcessing(false);
					return resolve(newMsg.get());
				});
			}

			//Condition when user provides Password or Date of birth.
			if(postback === false && data === "password" || data === "dob") {

				//TODO:See if password contains space.

				//if(message.split(' ').length >= 2) {
					//Check to see if the user is trying to commmunicate something else.
				//}
				var password = S(message).trim().toString();
				var loginStatus = false;
				var dataForCrawl = null;

				rClient.hgetAsync(userID, 'temp_username').then(function(ures){

					var typeData = data;
					if(data === "dob") {
						typeData = "regbirth";
					} else {
						typeData = "password";
					}

					dataForCrawl = {userID : userID, type : typeData, username : ures, password : password};
					console.log(JSON.stringify(dataForCrawl));

					startLoginProcess(dataForCrawl).then(function(crawlData){
						
						console.log("I am in true condition");
						console.log("done login process -\n" + JSON.stringify(crawlData));

						dbclient.newUpdateBuilder(DDBTable)
						.enableUpsert()
						.setHashKey(DDBHashKey, userID)
						.putAttribute('username', ures)
						.putAttribute('password', password)
						.putAttribute('credentials_type', typeData)
						.execute()
						.then(function(d){
							console.log("have put item "+ d);
							rClient.hdel(userID, 'expecting');
							rClient.hdel(userID, 'temp_username');
							rClient.hdel(userID, 'temp_password');
							
							iAmProcessing(false);
							rClient.hgetAsync(userID, 'due_action').then(function(res){

								if(res === "attendance") {
									getUserData().then(function(userData){
										return resolve(showAttendance(userData));
									});
								}
								else if(res === "marks") {
									getUserData().then(function(userData){
										return resolve(showMarks(userData));
									});
								} else {
									return resolve(getResponseTemplate(RESPONSETEMPLATE.MAIN_MENU, null));
								}

							});
						});
					}).catch(function(verr){
						console.log("I am in failed situation " + verr);
						rClient.hdel(userID, 'expecting');
						rClient.hdel(userID, 'temp_username');
						rClient.hdel(userID, 'temp_password');
						return resolve('Sorry! I was unable to login.');
					});


				});

			}

			//Condition when user provides Student ID.
			if(data === "studentid" && postback === false) {

				var studentid = S(message).trim();

				rClient.hmsetAsync(userID, ['expecting', 'dob', 'temp_username', studentid]).then(function(res){
					var newMsg = new fbTemplate.Text("Please give your date of birth in reply (in YYYY-MM-DD format)");
					newMsg.addQuickReply('Cancel login', 'cancel_login');
					iAmProcessing(false);
					return resolve(newMsg.get());
				});
			}

			//If we are expecting nothing from user, this executes. Normally the first message or random message.
			if(data === null) {

				//When user wants to check AMS.
				if(S(message.toLowerCase()).contains('ams')){

					getUserProfile().then(function(userData){
						console.log("This is the final data " + userData);
						console.log("This is final " + typeof(userData));
						
						iAmProcessing(false);
						return resolve(getResponseTemplate(RESPONSETEMPLATE.MAIN_MENU, {name: userData.first_name}));
					});
				}
				else if (data === null && postback === false) {
					iAmProcessing(false);
					return resolve('Nothing to show bro');
				}
			}

				console.log("Got something." + data);
				
			}).catch(function(err){
				console.log("Got an error " + err);
			});

	console.log('worst case');


	});

  
});