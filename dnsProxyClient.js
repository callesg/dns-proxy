var dns = require('native-dns'),
	fs = require('fs'),
	stdio = require('stdio');

var Nibbler = require('./Nibbler.js').Nibbler;

var options = stdio.getopt({
	'dnsname': {
		key: 'd',
		args: 1,
		description: 'The dns name of the dns server example: dns.example.com',
		mandatory: true
	},
	'service': {
		key: 's',
		args: 1,
		description: 'The service that we want to connect to.',
		mandatory: true
	},
	'resolver': {
		key: 'r',
		args: 1,
		description: 'The ip number of the resolver server we want to use, default is read from /etc/resolv.conf'
	},
	'port': {
		key: 'p',
		args: 1,
		description: 'The resolver server port the default is 53'
	},
	'timing': {
		key: 't',
		args: 1,
		description: 'How often to normaly do dns requests in ms. 500 is default'
	},
	'mintiming': {
		key: 'ti',
		args: 1,
		description: 'Never send request faster than this(to lessen strain on resolvers) in ms. 50 is default'
	},
	'maxtiming': {
		key: 'ta',
		args: 1,
		description: 'Never send request slower than this (to slow is not good) in ms. 15000 is default'
	},
	'throttle': {
		key: 'tr',
		args: 1,
		description: 'How much to incresse the latency per request when there is no activity in ms. 100 is default'
	},
	'UseDualQuestion': {
		key: 'q',
		description: 'Use two questions per request. Some dns servers dont allow that. however if it is supported one can double the up bandwith'
	},
	'verbose': {
		key: 'v',
		description: 'Print more information to stderr'
	}
});

if (!options.resolver) {
	options.resolver = '127.0.0.1';
	var Lines = fs.readFileSync('/etc/resolv.conf').toString().split("\n");
	for (nr in Lines) {
		var opts = Lines[nr].split(' ');
		if (opts[0] == 'nameserver') {
			options.resolver = opts[1];
		}
	}
}

if (!options.mintiming) {
	options.mintiming = 15;
}
options.mintiming = parseInt(options.mintiming);

if (!options.maxtiming) {
	options.maxtiming = 15000;
}
options.maxtiming = parseInt(options.maxtiming);

if (!options.throttle) {
	options.throttle = 100;
}
options.throttle = parseInt(options.throttle);

if (!options.timing) {
	options.timing = 500;
}
options.timing = parseInt(options.timing);

if (!options.port) {
	options.port = 53;
}
options.port = parseInt(options.port);

var ResolveServer = options.resolver;
var ResolveServerPort = options.port;
var ServiceAlias = options.service;
var ProxyOwner = options.dnsname;


/*
A DNS name can be at max 253 (some places say 255 but i think they count with the start and stop bytes) bytes long and
each subdomain maximumly 63 bytes which means that we need to insert 4 dots thats where 249 comes from
*/
var MaxDataBytesInTxt = 249;
var RequestCounter = 0;
var LastRecivedID = 0;
var DNSPacketID = 5;

var b32cbits = 5;
var base32 = new Nibbler({
	dataBits: 8,
	codeBits: b32cbits,
	keyString: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
	pad: '',
	arrayData: true
});

var Numbase32 = new Nibbler({
	dataBits: 20,
	codeBits: b32cbits,
	keyString: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
    pad: '',
	arrayData: true
});

var DownData = [];
var FinishedDownData = [];
var NextDownDataID = 0;

//Create A random Number that will be the Id of our session
var ConnectionIDNum = Math.round(Math.random() * 100000);
var SubmitedTotData = 0;

var AppendStr = '.' + ServiceAlias + '.' + ProxyOwner
var DomainNameQue = [];

//Handle Input from the ssh client
process.openStdin();
process.stdin.resume();


//Force Raw mode i someone might wan't this
//require('tty').setRawMode(true);


//When we get data from the ssh Client
process.stdin.on('data', function(chunk) {
	InputData2DomainNames(chunk);
	HandleDomainNameQue(true);
});

process.stdin.on('end', function() {
	console.error("Report to server that we are exiting");
	process.exit();
});

var CurrentTimeOut = setTimeout(HandleDomainNameQue, 1);
var CurrentActivity = 0;
var WhenWasTheLastRequestSubmited = 0;


function HandleDomainNameQue(Activity) { //when Activity is on we reset the timer and sends next query soner than scheduled
	var When2RunNextTime = options.timing;

	if (DomainNameQue.length != 0) {
		Activity = true;
	}
	clearTimeout(CurrentTimeOut);

	//if somthing has happend here or on the server
	if (Activity) {
		CurrentTime = (new Date()).getTime();
		CurrentActivity = 0;

		if (CurrentTime - WhenWasTheLastRequestSubmited >= options.mintiming) {
			SubmitRequestFromDomainNameQue();
			WhenWasTheLastRequestSubmited = (new Date()).getTime();
		} else {
			When2RunNextTime = options.mintiming - (CurrentTime - WhenWasTheLastRequestSubmited);
		}
	} else {
		SubmitRequestFromDomainNameQue();
		WhenWasTheLastRequestSubmited = (new Date()).getTime();
		CurrentActivity = Math.min(CurrentActivity + options.throttle, options.maxtiming);
		When2RunNextTime = options.timing + CurrentActivity;
	}
	CurrentTimeOut = setTimeout(HandleDomainNameQue, When2RunNextTime);
}


function Add2DomainNameQue(req1, req2) {
	DomainNameQue.push([req1, req2])
	RequestCounter++;
}

function SubmitRequestFromDomainNameQue() {
	if (DomainNameQue.length == 0) {
		SubmitDnsRequest();
	} else {
		var nextRequest = DomainNameQue.shift()
		SubmitDnsRequest(nextRequest[0], nextRequest[1]);
	}
}

function InputData2DomainNames(InputData) {

	var SubmitedBytes = 0;
	while (InputData.length != SubmitedBytes) {

		var DomainName = InputData2DomainName();
		var SecondDomainName;

		//If We should use the secound query
		if (options.UseDualQuestion && InputData.length != SubmitedBytes) {
			SecondDomainName = InputData2DomainName();
		}
		Add2DomainNameQue(DomainName, SecondDomainName);
	}
	SubmitedTotData += SubmitedBytes;

	function InputData2DomainName() {
		var PacketData = Numbase32.encode([ConnectionIDNum, LastRecivedID, DNSPacketID, RequestCounter]);
		var DomainNameOrg = PacketData + AppendStr;

		var UsableChars = Math.abs(Math.floor(MaxDataBytesInTxt - DomainNameOrg.length));
		var Bytes2Use = Math.min(InputData.length - SubmitedBytes, Math.floor(UsableChars * (b32cbits / 8)));

		var ActualData = base32.encode(InputData.slice(SubmitedBytes, SubmitedBytes + Bytes2Use));
		SubmitedBytes += Bytes2Use;

		var FormatedData = '';
		while (ActualData.length > 63) {
			FormatedData += ActualData.substr(0, 63) + ".";
			ActualData = ActualData.substr(63)
		}
		FormatedData += ActualData + ".";
		DNSPacketID++;
		return (FormatedData + DomainNameOrg);
	}
}

function SubmitDnsRequest(DomainName, SecondDomainName) {

	if (typeof(DomainName) == 'undefined') {
		var PacketData = Numbase32.encode([ConnectionIDNum, LastRecivedID, DNSPacketID, RequestCounter]);
		RequestCounter++;
		DomainName = PacketData + AppendStr;
	}

	var question = dns.Question({
		name: DomainName,
		type: 'TXT',
		class: 1
	});

	var req = dns.Request({
		question: question,
		server: {
			address: ResolveServer,
			port: ResolveServerPort,
			type: 'udp'
		},
		cache: false,
		timeout: 7000
	});

	if (typeof(SecondDomainName) != 'undefined') {
		var question2 = dns.Question({
			name: SecondDomainName,
			type: 'TXT',
			class: 1
		});
		req.questions = [req.question, question2];
	}

	req.on('timeout', function() {
		var redoname = this.question.name;
		setTimeout(function() {
			SubmitDnsRequest(redoname);
		}, 500);
	});

	req.on('message', function(err, answer) { //err should be null
		if (err != null) {
			console.error("Got an error:", err);
		}


		answer.answer.forEach(function(a) {
			if (a.type == 16) {

				var Splitpos = a.data.indexOf(':');
				if (Splitpos == -1) {
					console.error("ERROR answer not correctly formated could not find the split position got back the following answer data:", a.data);
                    process.exit(3);
				}
				var Parts = a.data.substr(0, Splitpos);
				a.data = a.data.substr(Splitpos + 1);
				Parts = Parts.split(".");

				if (Parts.length > 2 && ConnectionIDNum == Parts[0]) {
					var RequestMoreData = false;
					if (typeof(DownData[Parts[1]]) == 'undefined') {
						DownData[Parts[1]] = a.data
						if (a.data.length < Parts[2]) {
							RequestMoreData = true;
						}
					} else {
						console.error("ERROR got back duplicates of a request with DownDataID:", Parts[1], a);
					}

					FinishedDownData[Parts[1]] = Parts[1];
					for (key in FinishedDownData) {
						var dwid = FinishedDownData[key];
						if (dwid == NextDownDataID) {
							process.stdout.write(DownData[dwid], 'base64');
							LastRecivedID = dwid;
							delete DownData[dwid];
							delete FinishedDownData[key];
							NextDownDataID += 1;
						}
					}
					if (RequestMoreData) {
						HandleDomainNameQue(true);
					}
				} else {
					console.error("ERROR answer not correctly formated to few subdomains got back the following answer data:", a.data);
                    process.exit(2);
				}
			} else {
				console.error("ERROR answer not correctly formated it is not of type 16 got back the following answer:", a.name);
                process.exit(1);
			}
		});
	});
	req.send();
}
