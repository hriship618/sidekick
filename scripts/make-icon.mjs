import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
await mkdir('resources', { recursive: true });
const pixels = Array.from({length:16},()=>Array.from({length:16},()=>[0,0,0,0]));
function rect(x,y,w,h,color){const rgba=[...color.match(/../g).map(v=>parseInt(v,16)),255];for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)pixels[j][i]=rgba;}
rect(1,8,2,3,'8062cf');rect(13,8,2,3,'8062cf');
rect(4,12,3,2,'8e70de');rect(9,12,3,2,'8e70de');
rect(4,4,8,1,'a78bfa');rect(3,5,10,2,'a78bfa');rect(2,7,12,4,'a78bfa');rect(3,11,10,1,'9475e7');
rect(4,4,8,1,'c4afff');rect(5,7,2,2,'2a203b');rect(9,7,2,2,'2a203b');
function crc(data){let c=0xffffffff;for(const byte of data){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,data])),8+data.length);return b;}
function png(size){const raw=Buffer.alloc(size*(size*4+1));for(let y=0;y<size;y++)for(let x=0;x<size;x++){const pixel=pixels[Math.floor(y*16/size)][Math.floor(x*16/size)];for(let c=0;c<4;c++)raw[y*(size*4+1)+1+x*4+c]=pixel[c];}const h=Buffer.alloc(13);h.writeUInt32BE(size);h.writeUInt32BE(size,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const sizes=[16,32,48,256],images=sizes.map(png),header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
for(let i=0;i<sizes.length;i++){const at=6+i*16;header[at]=header[at+1]=sizes[i]===256?0:sizes[i];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(images[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[i].length;}
await writeFile('resources/rove.ico',Buffer.concat([header,...images]));
await writeFile('resources/rove.png',images[3]);
await writeFile('src/tray.png',images[1]);
