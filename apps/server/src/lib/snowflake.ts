const EPOCH = BigInt(Date.UTC(2026, 0, 1));
const WORKER_ID = BigInt(Number(process.env.SNOWFLAKE_WORKER_ID ?? 1) & 0x3ff);

let lastTimestamp = 0n;
let sequence = 0n;

function currentMs() {
  return BigInt(Date.now());
}

function waitNextMs(timestamp: bigint) {
  let next = currentMs();
  while (next <= timestamp) {
    next = currentMs();
  }
  return next;
}

export function newSnowflakeId() {
  let timestamp = currentMs();

  if (timestamp < lastTimestamp) {
    timestamp = lastTimestamp;
  }

  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) {
      timestamp = waitNextMs(lastTimestamp);
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = timestamp;

  return (((timestamp - EPOCH) << 22n) | (WORKER_ID << 12n) | sequence).toString();
}
