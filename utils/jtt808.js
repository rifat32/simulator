'use strict';

const MSG_ID = {
  REGISTER: 0x0100,
  AUTH: 0x0102,
  HEARTBEAT: 0x0002,
  LOCATION: 0x0200,
  TRANSPARENT: 0x0900
};

// Extension IDs as per J63 and Jiangsu standards
const EXT_ID = {
  OBD_DATA: 0xF3,           // J63 OBD Extension
  ADAS_ALARM_JS: 0x64,      // Jiangsu Standard ADAS (used for Lane Departure etc)
  DSM_ALARM_JS: 0x65        // Jiangsu Standard DSM
};

// OBD PID Mapping (Sheet 4)
const OBD_PID = {
  RPM: 0x0003,
  ENGINE_LOAD: 0x0008,
  COOLANT_TEMP: 0x0009
};

const ADAS_ALARM_TYPE = {
  COLLISION_WARNING: 0x01, // Forward Collision
  LANE_DEPARTURE: 0x02,
  FREQUENT_LANE_CHANGE: 0x05,
  FATIGUE_DRIVING: 0x0A,
  HARD_ACCELERATION: 0x0B,
  HARD_BRAKING: 0x0C,
  SPEEDING: 0x0D
};

function intToBcd(num, len) {
  const bcd = Buffer.alloc(len);
  const str = String(num).padStart(len * 2, '0');
  for (let i = 0; i < len; i++) {
    bcd[i] = parseInt(str.substr(i * 2, 2), 16);
  }
  return bcd;
}

function calculateChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < buf.length; i++) cs ^= buf[i];
  return cs;
}

function escapeBuffer(buf) {
  let escaped = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7e) escaped.push(0x7d, 0x02);
    else if (buf[i] === 0x7d) escaped.push(0x7d, 0x01);
    else escaped.push(buf[i]);
  }
  return Buffer.from(escaped);
}

function unescapeBuffer(buf) {
  let unescaped = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d) {
      i++;
      if (buf[i] === 0x02) unescaped.push(0x7e);
      else if (buf[i] === 0x01) unescaped.push(0x7d);
    } else {
      unescaped.push(buf[i]);
    }
  }
  return Buffer.from(unescaped);
}

function parseDeviceIdToIMEI(deviceId) {
  const parts = deviceId.split('-');
  const type = parts[0];
  const num = parts[1] || '001';
  
  let typeCode = '0';
  if (type === 'DASH') typeCode = '1';
  else if (type === 'OBD') typeCode = '2';
  else if (type === 'TRK') typeCode = '3';

  return `868120${typeCode}${num.padStart(5, '0')}`;
}

const serialMap = new Map();
function getNextSerial(imei) {
  const s = (serialMap.get(imei) || 0) + 1;
  serialMap.set(imei, s % 65535);
  return s;
}

/**
 * buildMessage — raw unframed message (header + body + checksum).
 * Used by the media upload TCP loop which does its own escaping + 0x7E wrapping.
 */
function buildMessage(msgId, imei, body, serialOverride) {
  const phone = intToBcd(imei, 6);
  const serial = Buffer.alloc(2);
  const seqNum = (serialOverride !== undefined) ? serialOverride : getNextSerial(imei);
  serial.writeUInt16BE(seqNum & 0xffff);

  const msgProps = Buffer.alloc(2);
  msgProps.writeUInt16BE(body.length);

  const header = Buffer.concat([
    Buffer.from([msgId >> 8, msgId & 0xff]),
    msgProps,
    phone,
    serial,
  ]);

  const content = Buffer.concat([header, body]);
  const checksum = Buffer.from([calculateChecksum(content)]);
  return Buffer.concat([content, checksum]);
}

function buildPacket(imei, msgId, body) {
  const phone = intToBcd(imei, 6);
  const serial = Buffer.alloc(2);
  serial.writeUInt16BE(getNextSerial(imei));

  const msgProps = Buffer.alloc(2);
  msgProps.writeUInt16BE(body.length);

  const header = Buffer.concat([
    Buffer.from([msgId >> 8, msgId & 0xff]),
    msgProps,
    phone,
    serial,
  ]);

  const content = Buffer.concat([header, body]);
  const checksum = Buffer.from([calculateChecksum(content)]);
  const rawPacket = Buffer.concat([content, checksum]);
  const escapedPacket = escapeBuffer(rawPacket);

  return Buffer.concat([
    Buffer.from([0x7e]),
    escapedPacket,
    Buffer.from([0x7e]),
  ]);
}

function buildRegisterBody(imei, plateStr) {
  const manufacturer = Buffer.alloc(5);
  manufacturer.write('SIMUL');

  const model = Buffer.alloc(20);
  model.write('MODEL01');

  const terminalId = Buffer.alloc(7);
  terminalId.write(String(imei).slice(-7));

  const plateBuf = Buffer.from(plateStr);

  return Buffer.concat([
    Buffer.from([0x00, 0x00]), // Province ID
    Buffer.from([0x00, 0x00]), // City ID
    manufacturer,              // Manufacturer (5 bytes)
    model,                     // Model (20 bytes)
    terminalId,                // Terminal ID (7 bytes)
    Buffer.from([0x01]),       // Plate Color (Blue)
    plateBuf,                  // Plate String
  ]);
}

/**
 * Builds the 0x0200 Location Body with OBD and ADAS extensions
 */
function buildLocationBody(lat, lng, speedKmh, direction, extensions = []) {
  const alarm = Buffer.alloc(4); // Basic alarms
  const status = Buffer.alloc(4);

  let statusBits = 0b11; // ACC ON, Positioned
  let latValue = lat;
  let lngValue = lng;

  if (latValue < 0) { statusBits |= 1 << 2; latValue = Math.abs(latValue); }
  if (lngValue < 0) { statusBits |= 1 << 3; lngValue = Math.abs(lngValue); }
  status.writeUInt32BE(statusBits);

  const latBuf = Buffer.alloc(4);
  latBuf.writeUInt32BE(Math.round(latValue * 1000000));
  const lngBuf = Buffer.alloc(4);
  lngBuf.writeUInt32BE(Math.round(lngValue * 1000000));

  const altitude = Buffer.from([0x00, 0x32]);
  const speedBuf = Buffer.alloc(2);
  speedBuf.writeUInt16BE(Math.round(speedKmh * 10));
  const dirBuf = Buffer.alloc(2);
  dirBuf.writeUInt16BE(Math.round(direction));

  const time = new Date();
  const timeStr =
    time.getFullYear().toString().slice(2) +
    (time.getMonth() + 1).toString().padStart(2, '0') +
    time.getDate().toString().padStart(2, '0') +
    time.getHours().toString().padStart(2, '0') +
    time.getMinutes().toString().padStart(2, '0') +
    time.getSeconds().toString().padStart(2, '0');
  const timeBcd = intToBcd(timeStr, 6);

  let body = Buffer.concat([
    alarm,
    status,
    latBuf,
    lngBuf,
    altitude,
    speedBuf,
    dirBuf,
    timeBcd,
  ]);

  // Append Additional Information extensions (Sheet 4 / Jiangsu)
  for (const ext of extensions) {
    const extHeader = Buffer.from([ext.id, ext.content.length]);
    body = Buffer.concat([body, extHeader, ext.content]);
  }

  return body;
}

function buildOBDExtension(rpm, engineLoad, coolantTemp) {
  // Nested TLV for OBD (Sheet 4)
  // [ID:2][Len:1][Value:N]
  
  const createItem = (id, val, len) => {
    const b = Buffer.alloc(3 + len);
    b.writeUInt16BE(id, 0);
    b.writeUInt8(len, 2);
    if (len === 2) b.writeUInt16BE(val, 3);
    else if (len === 1) b.writeUInt8(val, 3);
    return b;
  };

  const obdBody = Buffer.concat([
    createItem(OBD_PID.RPM, rpm, 2),
    createItem(OBD_PID.ENGINE_LOAD, engineLoad, 1),
    createItem(OBD_PID.COOLANT_TEMP, coolantTemp, 1)
  ]);

  return { id: EXT_ID.OBD_DATA, content: obdBody };
}

let alarmSerialCounter = 1;

function buildADASAlarmExtension(alarmType, imei) {
  // SUYING / JSATL Standard 47-byte ADAS Alarm structure 
  const content = Buffer.alloc(47, 0); 
  
  // Byte 0-3: Alarm ID / Serial
  content.writeUInt32BE(alarmSerialCounter++, 0); 
  
  // Byte 4: State / Flag (0x00 or 0x01)
  content.writeUInt8(0x00, 4); 
  
  // Byte 5: Event / Alarm Type 
  content.writeUInt8(alarmType, 5); 
  
  // Byte 6: Level / Severity (0x01 = Low, 0x02 = Medium/High)
  content.writeUInt8(0x01, 6); 
  
  // Byte 7: Vehicle Speed
  content.writeUInt8(50, 7); 
  
  // Byte 8: Distance (10m)
  content.writeUInt8(10, 8);
  
  // ... Bytes 9-30: Assorted metrics and embedded location (zeros are ignored)

  // Byte 31-46: 16-Byte Alarm Identification (hex_id)
  const hexIdOffset = 31;
  const terminalId = String(imei).padStart(7, '0').slice(-7);
  // Replicating real device: setting Terminal ID to 7 bytes of 0x00
  Buffer.alloc(7, 0).copy(content, hexIdOffset); 
  
  const time = new Date();
  const timeStr = 
    time.getFullYear().toString().slice(2) + 
    (time.getMonth()+1).toString().padStart(2,'0') + 
    time.getDate().toString().padStart(2,'0') +
    time.getHours().toString().padStart(2,'0') +
    time.getMinutes().toString().padStart(2,'0') +
    time.getSeconds().toString().padStart(2,'0');
  
  intToBcd(timeStr, 6).copy(content, hexIdOffset + 7);
  
  content.writeUInt8(0x00, hexIdOffset + 13); // Serial
  content.writeUInt8(0x05, hexIdOffset + 14); // Attachment count (matches real device)
  content.writeUInt8(0x00, hexIdOffset + 15); // Reserved
  
  const hexIdStr = content.slice(hexIdOffset, hexIdOffset + 16).toString('hex');
  
  return { id: EXT_ID.ADAS_ALARM_JS, content: content, hexId: hexIdStr };
}

function build0001Body(replySeqNum, replyMsgId, result = 0) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(replySeqNum, 0);
  body.writeUInt16BE(replyMsgId, 2);
  body.writeUInt8(result, 4);
  return body;
}

function build1210Body(imei, hexIdStr) {
  const terminalId = Buffer.alloc(7, 0);
  terminalId.write(String(imei).slice(-7));
  const alarmId = Buffer.from(hexIdStr, 'hex'); // 16 bytes
  const alarmNum = Buffer.alloc(32, 0);          // Empty alarm number field
  const infoType = Buffer.from([0x00]);           // 0x00 = Normal
  const attachCount = Buffer.from([0x02]);        // 2 files

  // Bug fix: write file size BEFORE Buffer.concat so it lands in the final buffer
  const vName = Buffer.from(`02_64_6401_03_${hexIdStr}.mp4`);
  const vSizeBuf = Buffer.alloc(4);
  vSizeBuf.writeUInt32BE(65536, 0);
  const vItem = Buffer.concat([Buffer.from([vName.length]), vName, vSizeBuf]);

  const pName = Buffer.from(`00_64_6401_00_${hexIdStr}.jpg`);
  const pSizeBuf = Buffer.alloc(4);
  pSizeBuf.writeUInt32BE(65536, 0);
  const pItem = Buffer.concat([Buffer.from([pName.length]), pName, pSizeBuf]);

  return Buffer.concat([terminalId, alarmId, alarmNum, infoType, attachCount, vItem, pItem]);
}

function build1211Body(imei, filename, filesize) {
  const terminalId = Buffer.alloc(7, 0);
  terminalId.write(String(imei).slice(-7)); 
  const nameBuf = Buffer.from(filename);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(filesize);
  return Buffer.concat([terminalId, Buffer.from([nameBuf.length]), nameBuf, sizeBuf]);
}

function build1212Body(filename, offset, dataBuf) {
  const nameBuf = Buffer.from(filename);
  const header = Buffer.alloc(1 + nameBuf.length + 8);
  header.writeUInt8(nameBuf.length, 0);
  nameBuf.copy(header, 1);
  header.writeUInt32BE(offset, 1 + nameBuf.length);
  header.writeUInt32BE(dataBuf.length, 1 + nameBuf.length + 4);
  return Buffer.concat([header, dataBuf]);
}

function extractFrames(buffer) {
  const frames = [];
  let startIdx = buffer.indexOf(0x7e);
  while (startIdx !== -1) {
    const endIdx = buffer.indexOf(0x7e, startIdx + 1);
    if (endIdx !== -1) {
      if (endIdx - startIdx > 1) frames.push(buffer.slice(startIdx, endIdx + 1));
      startIdx = endIdx; 
    } else break;
  }
  return { frames, remaining: startIdx !== -1 ? buffer.slice(startIdx) : Buffer.alloc(0) };
}

module.exports = {
  MSG_ID,
  EXT_ID,
  ADAS_ALARM_TYPE,
  parseDeviceIdToIMEI,
  buildMessage,
  buildPacket,
  buildRegisterBody,
  buildLocationBody,
  buildOBDExtension,
  buildADASAlarmExtension,
  build0001Body,
  build1210Body,
  build1211Body,
  build1212Body,
  unescapeBuffer,
  extractFrames
};
