// src/routes/api/ai-chat/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OpenAI } from 'openai';

const tools = [
	{
		type: 'function',
		function: {
			name: 'query_db',
			description: 'Queries the satellite database',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The SQL query to be executed'
					},
					intent: {
						type: 'string',
						enum: ['show_objects', 'draw_orbits'],
						description: 'Whether to toggle the visibility of the satellites or draw their orbits'
					}
				},
				required: ['query', 'intent']
			}
		}
	}
];

const createGpTable = `
CREATE TABLE IF NOT EXISTS gp ( 
	CCSDS_OMM_VERS VARCHAR(3) NOT NULL,
	COMMENT VARCHAR(33) NOT NULL,
	CREATION_DATE DATETIME,
	ORIGINATOR VARCHAR(7) NOT NULL,
	OBJECT_NAME VARCHAR(25),
	OBJECT_ID VARCHAR(12),
	CENTER_NAME VARCHAR(5) NOT NULL,
	REF_FRAME VARCHAR(4) NOT NULL,
	TIME_SYSTEM VARCHAR(3) NOT NULL,
	MEAN_ELEMENT_THEORY VARCHAR(4) NOT NULL,
	EPOCH DATETIME,
	MEAN_MOTION DECIMAL(13,8),
	ECCENTRICITY DECIMAL(13,8),
	INCLINATION DECIMAL(7,4),
	RA_OF_ASC_NODE DECIMAL(7,4),
	ARG_OF_PERICENTER DECIMAL(7,4),
	MEAN_ANOMALY DECIMAL(7,4),
	EPHEMERIS_TYPE TINYINT,
	CLASSIFICATION_TYPE CHAR(1),
	NORAD_CAT_ID INTEGER UNSIGNED PRIMARY KEY NOT NULL,
	ELEMENT_SET_NO SMALLINT UNSIGNED,
	REV_AT_EPOCH MEDIUMINT UNSIGNED,
	BSTAR DECIMAL(19,14),
	MEAN_MOTION_DOT DECIMAL(9,8),
	MEAN_MOTION_DDOT DECIMAL(22,13),
	SEMIMAJOR_AXIS DOUBLE(12,3),
	PERIOD DOUBLE(12,3),
	APOAPSIS DOUBLE(12,3),
	PERIAPSIS DOUBLE(12,3),
	OBJECT_TYPE VARCHAR(12),
	RCS_SIZE CHAR(6),
	COUNTRY_CODE CHAR(6),
	LAUNCH_DATE DATE,
	SITE CHAR(5),
	DECAY_DATE DATE,
	FILE BIGINT UNSIGNED,
	GP_ID INTEGER UNSIGNED NOT NULL,
	TLE_LINE0 VARCHAR(27),
	TLE_LINE1 VARCHAR(71),
	TLE_LINE2 VARCHAR(71)
);`;

const createSatcatTable = `
CREATE TABLE IF NOT EXISTS satcat ( 
	INTLDES CHAR(12) NOT NULL,
	NORAD_CAT_ID INTEGER UNSIGNED PRIMARY KEY NOT NULL,
	OBJECT_TYPE VARCHAR(12),
	SATNAME CHAR(25) NOT NULL,
	COUNTRY CHAR(6) NOT NULL,
	LAUNCH DATE,
	SITE CHAR(5),
	DECAY DATE,
	PERIOD DECIMAL(12,2),
	INCLINATION DECIMAL(12,2),
	APOGEE INTEGER UNSIGNED,
	PERIGEE INTEGER UNSIGNED,
	COMMENT CHAR(32),
	COMMENTCODE TINYINT UNSIGNED,
	RCSVALUE INTEGER NOT NULL DEFAULT 0,
	RCS_SIZE VARCHAR(6),
	FILE SMALLINT UNSIGNED NOT NULL DEFAULT 0,
	LAUNCH_YEAR SMALLINT UNSIGNED NOT NULL DEFAULT 0,
	LAUNCH_NUM SMALLINT UNSIGNED NOT NULL DEFAULT 0,
	LAUNCH_PIECE VARCHAR(3) NOT NULL,
	CURRENT CHAR(1) NOT NULL DEFAULT 'N' CHECK (CURRENT IN ('Y', 'N')),
	OBJECT_NAME CHAR(25) NOT NULL,
	OBJECT_ID CHAR(12) NOT NULL,
	OBJECT_NUMBER INTEGER UNSIGNED
);`;

const owner_lookup_table = `
Owner | Country/Organization
------|----------------------
AB    | ArabSat (Arab Satellite Communications Org.)
ABS   | Asia Broadcast Satellite
AC    | ASIASAT (Asia Satellite Telecommunications Co.)
ALG   | Algeria
ANG   | Angola
AGO   | Angola
ARGN  | Argentina
ASRA  | Austria
AUS   | Australia
AZER  | Azerbaijan
BEL   | Belgium
BELA  | Belarus
BERM  | Bermuda
BGD   | Bangladesh (Peoples Republic of)
BGR   | Bulgaria
BHUT  | Bhutan (Kingdom of)
BOL   | Bolivia
BRAZ  | Brazil
BUL   | Bulgaria
CA    | Canada
CHBZ  | China/Brazil
CHTU  | China/Turkey
CHLE  | Chile
CIS   | CIS (Commonwealth of Independent States)
COL   | Colombia
CRI   | Costa Rica (Republic of)
CZCH  | Czech Republic
CZE   | Czech Republic
DEN   | Denmark
ECU   | Ecuador
EGYP  | Egypt
ESA   | ESA (European Space Agency)
ESRO  | ESRO (European Space Research Org.)
EST   | Estonia
EUME  | EUMETSAT (European Org. for Meteorological Satellites)
EUTE  | EUTELSAT (European Telecommunications Satellite Org.)
FGER  | France/Germany
FIN   | Finland
FR    | France
FRIT  | France/Italy
GER   | Germany
GHA   | Ghana (Republic of)
GLOB  | Globalstar
GREC  | Greece
GRSA  | Greece/Saudi Arabia
GUAT  | Guatemala
HUN   | Hungary
IM    | INMARSAT (International Mobile Satellite Org.)
IND   | India
INDO  | Indonesia
IRAN  | Iran
IRAQ  | Iraq
IRID  | Iridium
ISRA  | Israel
ISRO  | ISRO (Indian Space Research Org.)
ISS   | ISS (International Space Station)
IT    | Italy
ITSO  | INTELSAT (International Telecommunications Satellite Org.)
JOR   | Jordan (Hashemite Kingdom of)
JPN   | Japan
KAZ   | Kazakhstan
KEN   | Kenya (Republic of)
KWT   | Kuwait
LAOS  | Laos
LKA   | Sri Lanka (Democratic Socialist Republic of)
LTU   | Lithuania
LUXE  | Luxembourg
MA    | Morocco
MALA  | Malaysia
MCO   | Monaco (Principality of)
MDA   | Moldova (Republic of)
MEX   | Mexico
MMR   | Myanmar (Republic of the Union of)
MNG   | Mongolia
MUS   | Mauritius
NATO  | NATO (North Atlantic Treaty Organization)
NETH  | Netherlands
NICO  | New ICO
NIG   | Nigeria
NKOR  | North Korea (Democratic People's Republic of)
NOR   | Norway
NPL   | Nepal (Federal Democratic Republic of)
NZ    | New Zealand
O3B   | O3b Networks
ORB   | ORBCOMM
PAKI  | Pakistan
PERU  | Peru
PER   | Peru
POL   | Poland
POR   | Portugal
PRC   | China (People's Republic of)
PRY   | Paraguay (Republic of)
PRES  | China/ESA (People's Republic of China/European Space Agency)
QAT   | Qatar (State of)
RASC  | RascomStar-QAF
ROC   | Taiwan (Republic of China)
ROM   | Romania
RP    | Philippines (Republic of the Philippines)
RWA   | Rwanda (Republic of)
SAFR  | South Africa
SAUD  | Saudi Arabia
SDN   | Sudan (Republic of)
SEAL  | Sea Launch
SES   | SES
SGJP  | Singapore/Japan
SING  | Singapore
SKOR  | South Korea (Republic of Korea)
SPN   | Spain
STCT  | Singapore/Taiwan
SVK   | Slovakia
SVN   | Slovenia
SWED  | Sweden
SWTZ  | Switzerland
TBD   | To Be Determined
THAI  | Thailand
TMMC  | Turkmenistan/Monaco
TUN   | Tunisia (Republic of)
TURK  | Turkey
TWN   | Taiwan
UAE   | United Arab Emirates
UK    | United Kingdom
UKR   | Ukraine
UNK   | Unknown
URY   | Uruguay
US    | United States
USBZ  | United States/Brazil
VENZ  | Venezuela
VTNM  | Vietnam
`;

export const POST: RequestHandler = async ({ request }) => {
	try {
		console.log('Request body: ', request.body);
		const requestBody = await request.json();
		const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
		const data = await openai.chat.completions.create({
			messages: [
				{
					role: 'system',
					content:
						'You are an SQL-generating interface to a satellite database. SELECT the NORAD_CAT_IDs the user wants to show objects or draw their orbits. Your tables are: ' +
						createGpTable +
						createSatcatTable +
						owner_lookup_table +
						'Remember, we are looking only for NORAD_CAT_IDs. Countries may have multiple aliases, eg for China make a where clauses similar to WHERE COUNTRY IN ("PRC", "CHLE", "CHTU", "CHBZ")'
				},
				...requestBody.chatHistory
			],
			model: 'gpt-3.5-turbo',
			tools: tools,
			tool_choice: 'auto'//{"type": "function", "function": {"name": "query_db"}}
		});
		return json(JSON.stringify(data));
	} catch (e) {
		console.error('Error parsing request body: ', e);
		return json({ error: 'Error parsing request body' }, { status: 400 });
	}
};
