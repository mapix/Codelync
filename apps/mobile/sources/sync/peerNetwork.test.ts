import nacl from'tweetnacl';
import{expect,it,vi}from'vitest';
vi.mock('expo-crypto', () => {
 let nonce = 0;
 return { getRandomBytes: vi.fn((count: number) => new Uint8Array(count).fill(++nonce)) };
});
import{peerAuthorization,decodePeerResponse,sealPeerRequest,PEER_ACTIVITY_REQUEST_MAX_BYTES}from'./peerNetwork';
import{decodeBase64,encodeBase64}from'@/encryption/base64';
import { gzipSync } from 'node:zlib';
import { encodeCompactPeerPlaintext, PEER_RESPONSE_MAX_BYTES } from '@slopus/happy-wire/peer-codec';
function requestPeer(){
 const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)),phone=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
 const peer={id:'ab'.repeat(32),key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 return{mac,phone,peer};
}
it('seals activity descriptors and binds compact peer/method/path scope with a fresh native nonce',()=>{
 const{mac,phone,peer}=requestPeer(),body={activityProtocol:2,clientId:'client',requestSeq:1,groups:[{id:'private-ui-group',projectKey:'/private/project/用户',hostId:'local',sessions:[{id:'relay-id',nativeId:'native-private-id'}]}]};
 const packet=sealPeerRequest(peer,body,'/api/peer/activity','POST'),again=sealPeerRequest(peer,body,'/api/peer/activity','POST');
 const wire=JSON.stringify(packet);expect(packet[0]).toBe(2);expect(decodeBase64(packet[1],'base64url')).toHaveLength(24);expect(again[1]).not.toBe(packet[1]);
 for(const value of ['/private/project','private-ui-group','native-private-id',peer.device.secretKey])expect(wire).not.toContain(value);
 const opened=nacl.box.open(decodeBase64(packet[2],'base64url'),decodeBase64(packet[1],'base64url'),phone.publicKey,mac.secretKey)!;
 expect(JSON.parse(new TextDecoder().decode(opened))).toEqual([peer.id,'POST','/api/peer/activity',body]);
 const otherMac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(8));expect(nacl.box.open(decodeBase64(packet[2],'base64url'),decodeBase64(packet[1],'base64url'),phone.publicKey,otherMac.secretKey)).toBeNull();
 expect(()=>sealPeerRequest(peer,body,'/api/peer/history','POST')).toThrow('Unsupported');expect(()=>sealPeerRequest(peer,body,'/api/peer/activity','GET')).toThrow('Unsupported');
});
it('bounds UTF8 sealed request plaintext before it becomes a LAN carrier',()=>{
 const{peer}=requestPeer();expect(()=>sealPeerRequest(peer,{data:'🌍'.repeat(PEER_ACTIVITY_REQUEST_MAX_BYTES/2)},'/api/peer/activity','POST')).toThrow('too large');
});
it('sealed token renewals remain smaller than full interests without leaking their descriptors',()=>{
 const{peer}=requestPeer(),first={activityProtocol:2,clientId:'client',requestSeq:1,groups:[{id:'project',projectKey:'/fixture',app:'codex',hostId:'local',sessions:[{id:'row',nativeId:'native'}]}]},steady={activityProtocol:2,clientId:'client',requestSeq:2,interestToken:'token',since:'watermark-1'};
 const initial=sealPeerRequest(peer,first,'/api/peer/activity','POST'),next=sealPeerRequest(peer,steady,'/api/peer/activity','POST');
 const size=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x)).length;
 expect(size(next)).toBeLessThan(size(initial));expect(JSON.stringify(initial)).not.toContain('/fixture');
 console.info('synthetic sealed activity HTTP body bytes (excluding authorization, HTTP and TLS)',JSON.stringify({initialCarrierBytes:size(initial),steadyCarrierBytes:size(next)}));
});
it('cold peer authentication does not depend on a pairing provider installing TweetNaCl PRNG', () => {
 const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)),phone=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
 const peer={id:'cold-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 const unavailable=vi.spyOn(nacl,'randomBytes').mockImplementation(()=>{throw Error('no PRNG');});
 try {
  const header=peerAuthorization('fixture-token',peer,peer.channels[0].url,'GET',peer.channels[0].url+'/v1/updates');
  const packet=JSON.parse(new TextDecoder().decode(decodeBase64(header.slice(10),'base64url')));
  expect(nacl.box.open(decodeBase64(packet.ciphertext,'base64url'),decodeBase64(packet.nonce,'base64url'),phone.publicKey,mac.secretKey)).not.toBeNull();
  expect(unavailable).not.toHaveBeenCalled();
 } finally { unavailable.mockRestore(); }
});
it('authorization seals reusable tokens to the pinned Mac and changes nonce for reconnects',()=>{
 const mac=nacl.box.keyPair(),phone=nacl.box.keyPair();const peer={id:'fixture-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 const header=peerAuthorization('synthetic-secret-token',peer,peer.channels[0].url,'GET',peer.channels[0].url+'/v1/updates');
 expect(header).not.toContain('synthetic-secret-token');expect(peerAuthorization('synthetic-secret-token',peer,peer.channels[0].url,'GET',peer.channels[0].url+'/v1/updates')).not.toBe(header);
 const packet=JSON.parse(new TextDecoder().decode(decodeBase64(header.slice(10),'base64url')));
 const plain=nacl.box.open(decodeBase64(packet.ciphertext,'base64url'),decodeBase64(packet.nonce,'base64url'),phone.publicKey,mac.secretKey)!;
 expect(JSON.parse(new TextDecoder().decode(plain))).toMatchObject({token:'synthetic-secret-token',path:'/v1/updates',method:'GET'});
 const nonce=nacl.randomBytes(24),cipher=nacl.box(new TextEncoder().encode(JSON.stringify({peerId:peer.id,payload:{ok:true}})),nonce,phone.publicKey,mac.secretKey);
 expect(decodePeerResponse(peer,{version:2,nonce:encodeBase64(nonce,'base64url'),ciphertext:encodeBase64(cipher,'base64url')})).toEqual({ok:true});
 expect(()=>peerAuthorization('token',peer,'https://foreign.example','GET','https://foreign.example')).toThrow();
});

it('portable peer decoder restores negotiated compressed rows and compact deltas after authentication', () => {
 const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)),phone=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
 const peer={id:'ab'.repeat(32),key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 const payloads=[{version:1,rows:Array.from({length:20},(_,id)=>({id,source:'Antigravity',text:'Native Unicode 正文 '.repeat(70)}))},
  {version:2,mode:'delta',watermark:'fixture:17',baseWatermark:'fixture:17',machineIds:['fixture-machine'],sessions:[],removedIds:[],hasMore:false,nextCursor:null,scannedAt:1794575000000}];
 for(const payload of payloads){
  const plain=encodeCompactPeerPlaintext(peer.id,payload,body=>gzipSync(body));const nonce=new Uint8Array(24).fill(9),cipher=nacl.box(plain,nonce,phone.publicKey,mac.secretKey);
  const packet=[3,encodeBase64(nonce,'base64url'),encodeBase64(cipher,'base64url')];
  expect(decodePeerResponse(peer,packet)).toEqual(payload);
  expect(()=>decodePeerResponse({...peer,id:'cd'.repeat(32)},packet)).toThrow(/peer/);
  const bad=new Uint8Array(cipher);bad[0]^=1;
  expect(()=>decodePeerResponse(peer,[3,packet[1],encodeBase64(bad,'base64url')])).toThrow(/authenticate/);
 }
 const tooLarge=encodeCompactPeerPlaintext(peer.id,{ok:true});new DataView(tooLarge.buffer).setUint32(33,PEER_RESPONSE_MAX_BYTES+1,true);
 const nonce=new Uint8Array(24).fill(7),cipher=nacl.box(tooLarge,nonce,phone.publicKey,mac.secretKey);
 expect(()=>decodePeerResponse(peer,[3,encodeBase64(nonce,'base64url'),encodeBase64(cipher,'base64url')])).toThrow(/too-large/);
});

it('phase diagnostics preserve native payload and authentication failure semantics', () => {
 const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)),phone=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
 const peer={id:'ab'.repeat(32),key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'}],device:{publicKey:encodeBase64(phone.publicKey,'base64url'),secretKey:encodeBase64(phone.secretKey,'base64url')}};
 const payload={rows:[{id:'native',text:'Native Unicode 完整正文 '.repeat(100)}]};
 const plain=encodeCompactPeerPlaintext(peer.id,payload,body=>gzipSync(body)),nonce=new Uint8Array(24).fill(9),cipher=nacl.box(plain,nonce,phone.publicKey,mac.secretKey);
 const packet=[3,encodeBase64(nonce,'base64url'),encodeBase64(cipher,'base64url')];
 const phases: string[]=[];
 expect(decodePeerResponse(peer,packet,(stage,ms)=>{phases.push(stage);expect(ms).toBeGreaterThanOrEqual(0);})).toEqual(payload);
 expect(phases).toEqual(['validate','base64','authenticate','inflate','checksum','utf8','json']);
 const brokenObserver=()=>{throw Error('diagnostics unavailable');};
 expect(decodePeerResponse(peer,packet,brokenObserver)).toEqual(payload);
 const bad=new Uint8Array(cipher);bad[0]^=1;
 expect(()=>decodePeerResponse(peer,[3,packet[1],encodeBase64(bad,'base64url')],brokenObserver)).toThrow(/authenticate/);
});
