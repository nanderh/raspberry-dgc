const fetch = require('node-fetch');
const cron = require('node-cron');
const http = require('http');
const https = require('https');
const url = require('url');
const { DCC } = require('dcc-utils');
const rs = require('jsrsasign');
const vaccination = require("./vaccination.js")
const test = require("./test.js")
const recovery = require("./recovery.js")

const port = 3000;

const urlUpdate = "https://get.dgc.gov.it/v1/dgc/signercertificate/update";
const urlStatus = "https://get.dgc.gov.it/v1/dgc/signercertificate/status";
const urlSettings = "https://get.dgc.gov.it/v1/dgc/settings";

const ADD_HOLDER_DETAILS = false;

let validKids;
let signerCertificates;
let settings;

const updateCertificates = (async () => {

	console.log("Updating signer certificates...");

	// get the list of valid KIDs
	response = await fetch(urlStatus);
	validKids = await response.json();
	
	console.log(validKids.length + " valid KIDs downloaded" );
	
	// get the list of certificates
	signerCertificates = [];
	certificateDownloadedCount = 0;
	certificateAddedCount = 0;					  
	let headers = {};
	const httpsAgent = new https.Agent({ keepAlive: true });
	do {
		
		response = await fetch(urlUpdate, {
			headers,
			httpsAgent
		})
		
		headers = {'X-RESUME-TOKEN' : response.headers.get('X-RESUME-TOKEN')};
		const certificateKid = response.headers.get('X-KID');
		const certificate = await response.text();
		
		// a certificate has been downloaded
		if(certificate) {
			
			certificateDownloadedCount++;
			
			// the certificate is valid, add it to the list
			if(validKids.includes(certificateKid)) {
				certificateAddedCount++;
				signerCertificates.push("-----BEGIN CERTIFICATE-----\n" + certificate + "-----END CERTIFICATE-----");
			}
		}
	} while (response.status === 200);
	console.log(certificateDownloadedCount + " certificates downloaded, " + certificateAddedCount + " added");
});

const updateSettings = (async () => {

	console.log("Updating settings...");

	response = await fetch(urlSettings);
	settings = await response.json();
	
	console.log("Done");
});

const main = (async () => {

	await updateCertificates();
	await updateSettings();

	const server = http.createServer();
	server.on('request', async (req, res) => {
		
		// set CORS header to allow browser clients
		res.setHeader('Access-Control-Allow-Origin', '*');
		
		const dgc = url.parse(req.url, true).query.dgc;
		
		if(dgc === undefined) {
			res.statusCode = 400;
			res.setHeader('Content-Type', 'text/plain');
			res.end("Invalid DGC");
		}
		else {
			
			// init DCC library
			let dcc;
			try {
				dcc = await DCC.fromRaw(dgc);
			
			// error when decoding DGC
			} catch (e) {
			
				res.statusCode = 400;
				res.setHeader('Content-Type', 'text/plain');
				res.end("INVALID: " + e.message);
				return;		 
			}
			
			// check DGC signature
			let signatureVerified = false;
			for(let certificate of signerCertificates) {
							
				try {
					
					// get key and jwk from certificate
					key = rs.KEYUTIL.getKey(certificate);
					jwk = rs.KEYUTIL.getJWKFromKey(key);
					
					// EC key, the library expects x and y coordinates as hex strings
					if(jwk.kty == 'EC') {
						verifier = {
							x: Buffer.from(jwk.x, 'base64').toString('hex'),
							y: Buffer.from(jwk.y, 'base64').toString('hex')
						};
					}
					
					// RSA key, the library expects modulus and exponent as Buffers
					else if(jwk.kty == 'RSA') {
						verifier = {
							n: Buffer.from(jwk.n, 'base64'),
							e: Buffer.from(jwk.e, 'base64')
						};
					}
					
					signatureVerified = await dcc.checkSignature(verifier);
				} catch {}
				if(signatureVerified) break;
			}
			
			// no signer certificate found
			if(!signatureVerified) {
			
				res.statusCode = 400;
				res.setHeader('Content-Type', 'text/plain');
				res.end("INVALID: signature");
				return;					
			}
			
			// check DGC content
			let validate;
			
			// 1. vaccination
			if(dcc.payload.v) validate = vaccination.validateVaccination(settings, dcc);
			
			// 2. test
			if(dcc.payload.t) validate = test.validateTest(settings, dcc);
			
			// 3. recovery
			if(dcc.payload.r) validate = recovery.validateRecovery(settings, dcc);
			
			// Add holder details if required
			let response;
			if(ADD_HOLDER_DETAILS) {
				
				let surname = dcc.payload.nam.fn;
				let forename = dcc.payload.nam.gn;
				let dob = dcc.payload.dob;
				response = validate.message + " - " + surname + " " + forename + " (" + dob + ")";
			} else response = validate.message;
						
			if(validate.result) res.statusCode = 200;
			else res.statusCode = 400;
			res.setHeader('Content-Type', 'text/plain');
			res.end(response);				
		}
	});

	server.listen(port, () => {
	  console.log("validatorServer running");
	});
});

main();