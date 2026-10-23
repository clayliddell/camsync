const {test,expect}=require('@playwright/test');
test.use({hasTouch:true});

async function camera(page,{hardware=false,delay=0,reject=false,nativeRecorder=false,portrait=false}={}) {
  if(page.url()==='about:blank') await page.goto('/');
  test.skip(await page.evaluate(()=>!navigator.mediaDevices || !HTMLCanvasElement.prototype.captureStream || typeof MediaStream==='undefined'),
    'This test browser has no native media capture. Gesture-only coverage runs separately.');
  await page.route('**/auth/session',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await page.addInitScript(({hardware,delay,reject,nativeRecorder,portrait})=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const source=document.createElement('canvas');
      source.width=portrait?720:1280; source.height=portrait?1280:720;
      const context=source.getContext('2d');
      const paint=()=>{
        context.fillStyle='#ff0000';context.fillRect(0,0,source.width,source.height);
        context.fillStyle='#00ff00';context.fillRect(source.width*3/8,source.height*3/8,source.width/4,source.height/4);
        requestAnimationFrame(paint);
      };
      paint();
      const stream=source.captureStream(30), track=stream.getVideoTracks()[0];
      const audio=new AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0];
      stream.addTrack(audio);
      window.__camera=stream;
      const originalSettings=track.getSettings.bind(track);
      let zoom=1;
      track.getCapabilities=()=>hardware?{zoom:{min:0.5,max:3,step:0.25}}:{};
      track.getSettings=()=>({...originalSettings(),zoom});
      track.getConstraints=()=>({width:{exact:1280},height:{exact:720},frameRate:{exact:30}});
      window.__constraints=[];
      track.applyConstraints=async constraints=>{
        window.__constraints.push(constraints);
        await new Promise(resolve=>setTimeout(resolve,delay));
        if(reject) throw new Error('Zoom rejected');
        zoom=constraints.advanced.at(-1).zoom;
      };
      return stream;
    };
    if(!nativeRecorder) window.MediaRecorder=class{
      static isTypeSupported(type){return type.includes('hvc1')&&type.includes('mp4a.40.2');}
      constructor(stream,options){this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';window.__encoder=stream;}
      start(){this.state='recording';}
      stop(){this.state='inactive';this.ondataavailable({data:new Blob(['test clip'],{type:this.mimeType})});this.onstop();}
    };
  },{hardware,delay,reject,nativeRecorder,portrait});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
}

async function pinch(page,ratio,{release=true,type='touch'}={}) {
  await page.evaluate(({ratio,release,type})=>{
    const video=document.getElementById('cameraSurface');
    const event=(name,id,x)=>video.dispatchEvent(new PointerEvent(name,{bubbles:true,cancelable:true,pointerType:type,pointerId:id,clientX:x,clientY:300}));
    event('pointerdown',10,100);event('pointerdown',11,140);
    event('pointermove',11,100+40*ratio);
    if(release){event('pointerup',10,100);event('pointerup',11,100+40*ratio);}
  },{ratio,release,type});
}

const zoom=page=>page.evaluate(()=>cameraZoom.state.zoom);
const edge=page=>page.evaluate(()=>[...document.getElementById('zoomPreview').getContext('2d').getImageData(100,100,1,1).data]);

test('pinch and reset gestures work with camera controls in Chromium and WebKit',async({page})=>{
  await page.goto('/');
  await page.waitForFunction(()=>typeof cameraZoom!=='undefined');
  await page.evaluate(()=>{
    stopStream();
    let zoom=1;
    const track={getCapabilities:()=>({zoom:{min:1,max:4,step:0.1}}),getSettings:()=>({zoom}),
      getConstraints:()=>({}),applyConstraints:async c=>{zoom=c.advanced.at(-1).zoom;}};
    cameraZoom.start({getVideoTracks:()=>[track]});
  });
  await pinch(page,2);
  await expect.poll(()=>zoom(page)).toBe(2);
  await pinch(page,0.5);
  await expect.poll(()=>zoom(page)).toBe(1);
  await pinch(page,3);
  await page.getByRole('button',{name:/Camera zoom/}).click();
  await expect.poll(()=>zoom(page)).toBe(1);
});

test('pinch crops the digital recording stream, keeps microphone audio, and resets on camera flip',async({page})=>{
  await camera(page);
  await expect(page.locator('#zoomControl')).toBeVisible();
  await expect.poll(()=>edge(page)).toEqual([255,0,0,255]);
  await page.getByRole('button',{name:'Start recording',exact:true}).click();
  const identities=await page.evaluate(()=>({video:__encoder.getVideoTracks()[0].id,audio:__encoder.getAudioTracks()[0].id,
    cameraVideo:__camera.getVideoTracks()[0].id,cameraAudio:__camera.getAudioTracks()[0].id,
    settings:__encoder.getVideoTracks()[0].getSettings()}));
  expect(identities.video).not.toBe(identities.cameraVideo);
  expect(identities.audio).toBe(identities.cameraAudio);
  expect(await page.evaluate(()=>ui.preview.srcObject.getAudioTracks().length)).toBe(0);
  expect(identities.settings.width).toBe(1280);
  expect(identities.settings.height).toBe(720);
  expect(identities.settings.frameRate).toBe(30);
  await pinch(page,4);
  await expect.poll(()=>zoom(page)).toBe(4);
  await expect.poll(async()=>(await edge(page))[1]).toBeGreaterThan(240);
  expect(await page.evaluate(()=>__encoder.getVideoTracks()[0].id)).toBe(identities.video);
  expect(await page.evaluate(()=>__encoder.getAudioTracks()[0].readyState)).toBe('live');
  await pinch(page,0.5);
  await expect.poll(()=>zoom(page)).toBe(2);
  await page.getByRole('button',{name:/Camera zoom/}).click();
  await expect.poll(()=>zoom(page)).toBe(1);
  await pinch(page,2);
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Switch camera',exact:true}).click();
  await expect.poll(()=>zoom(page)).toBe(1);
  expect(await page.evaluate(()=>document.getElementById('zoomPreview').classList.contains('mirror'))).toBe(true);
});

test('camera zoom preserves capture constraints, clamps its range, and coalesces pinch updates',async({page})=>{
  await camera(page,{hardware:true,delay:40});
  await pinch(page,2);
  await expect.poll(()=>zoom(page)).toBe(2);
  await pinch(page,10);
  await expect.poll(()=>zoom(page)).toBe(3);
  await pinch(page,0.01);
  await expect.poll(()=>zoom(page)).toBe(0.5);
  const constraints=await page.evaluate(()=>__constraints);
  for(const c of constraints){expect(c.width).toEqual({exact:1280});expect(c.height).toEqual({exact:720});expect(c.frameRate).toEqual({exact:30});}
  await page.evaluate(()=>{cameraZoom.set(1);cameraZoom.set(1.5);cameraZoom.set(2.5);});
  await expect.poll(()=>zoom(page)).toBe(2.5);
  const calls=await page.evaluate(()=>__constraints.slice(3).map(c=>c.advanced.at(-1).zoom));
  expect(calls).toEqual([1,2.5]);
});

test('digital zoom preserves portrait 720p recording dimensions and frame rate',async({page})=>{
  await camera(page,{portrait:true});
  await pinch(page,2);
  await page.getByRole('button',{name:'Start recording',exact:true}).click();
  const dimensions=await page.evaluate(()=>__encoder.getVideoTracks()[0].getSettings());
  expect(dimensions.width).toBe(720);expect(dimensions.height).toBe(1280);expect(dimensions.frameRate).toBe(30);
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
});

test('cancelled gestures and mouse drags do not leave camera zoom moving',async({page})=>{
  await camera(page);
  await pinch(page,2,{type:'mouse'});
  expect(await zoom(page)).toBe(1);
  await pinch(page,2,{release:false});
  await expect.poll(()=>zoom(page)).toBe(2);
  await page.evaluate(()=>{
    const video=document.getElementById('cameraSurface');
    video.dispatchEvent(new PointerEvent('pointercancel',{pointerId:10,pointerType:'touch'}));
    video.dispatchEvent(new PointerEvent('pointermove',{pointerId:11,pointerType:'touch',clientX:1000,clientY:300}));
    video.dispatchEvent(new PointerEvent('pointerup',{pointerId:11,pointerType:'touch'}));
  });
  expect(await zoom(page)).toBe(2);
  await pinch(page,0.5);
  await expect.poll(()=>zoom(page)).toBe(1);
  expect(await page.locator('#cameraSurface').evaluate(e=>getComputedStyle(e).touchAction)).toBe('none');
});

test('a camera rejecting zoom keeps its last real zoom and recording track',async({page})=>{
  await camera(page,{hardware:true,reject:true});
  await pinch(page,2);
  await expect(page.getByRole('status')).toContainText('Couldn’t change camera zoom');
  expect(await zoom(page)).toBe(1);
  await page.getByRole('button',{name:'Start recording',exact:true}).click();
  expect(await page.evaluate(()=>__encoder.getVideoTracks()[0].id===__camera.getVideoTracks()[0].id)).toBe(true);
});

for (const hardware of [false,true]) {
  test(`real touch pinch keeps recording controls available with ${hardware?'camera':'digital'} zoom`,async({page,browserName})=>{
    test.skip(browserName!=='chromium','CDP touch injection requires Chromium; WebKit gesture logic is covered separately.');
    await camera(page,{hardware});
    const preview=await page.evaluate(()=>({muted:ui.preview.muted,defaultMuted:ui.preview.defaultMuted,controls:ui.preview.controls,
      inline:ui.preview.playsInline,audio:ui.preview.srcObject.getAudioTracks().length,
      target:document.elementFromPoint(120,300).id,events:getComputedStyle(ui.preview).pointerEvents}));
    expect(preview).toEqual({muted:true,defaultMuted:true,controls:false,inline:true,audio:0,target:'cameraSurface',events:'none'});
    await page.evaluate(()=>{window.__playerTouches=0;ui.preview.addEventListener('pointerdown',()=>window.__playerTouches++);});
    await page.getByRole('button',{name:'Start recording',exact:true}).click();
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
    const points=distance=>[{x:100,y:300,id:10},{x:100+distance,y:300,id:11}];
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(80)});
    for(const distance of [100,120,140,160]) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(distance)});
      await page.evaluate(()=>new Promise(requestAnimationFrame));
    }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(()=>zoom(page)).toBe(2);
    const state=await page.evaluate(()=>({recording:isRecording(),paused:ui.preview.paused,fullscreen:!!document.fullscreenElement,
      scale:visualViewport.scale,playerTouches:__playerTouches,audio:__encoder.getAudioTracks()[0].readyState}));
    expect(state).toEqual({recording:true,paused:false,fullscreen:false,scale:1,playerTouches:0,audio:'live'});
    const stop=page.getByRole('button',{name:'Stop recording',exact:true});
    await expect(stop).toBeVisible();
    await stop.tap();
    await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
    expect(await page.evaluate(async()=>(await listVideos())[0].size)).toBeGreaterThan(0);
  });
}

test('an autoplay-blocked preview retries from the app button without reopening camera or microphone',async({page})=>{
  await page.addInitScript(()=>{
    const play=HTMLMediaElement.prototype.play;
    window.__cameraRequests=0;
    const gum=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if(gum) navigator.mediaDevices.getUserMedia=async c=>{window.__cameraRequests++;return gum(c);};
    let blocked=true;
    HTMLMediaElement.prototype.play=function(){
      if(this.id==='preview'&&blocked){blocked=false;return Promise.reject(new DOMException('Autoplay blocked','NotAllowedError'));}
      return play.call(this);
    };
  });
  await page.goto('/');
  test.skip(await page.evaluate(()=>!navigator.mediaDevices),'This WebKit build has no camera capture.');
  await expect(page.locator('#overlayMsg')).toContainText('Tap Start camera');
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Start camera',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>__cameraRequests)).toBe(1);
});

test('encoded zoom is present in actual HEVC MP4 playback',async({page})=>{
  await page.goto('/');
  test.skip(await page.evaluate(()=>pickMime()===null),'No native HEVC/AAC encoder in this browser.');
  await camera(page,{nativeRecorder:true});
  await page.getByRole('button',{name:'Start recording',exact:true}).click();
  await page.waitForFunction(()=>recorder?.state==='recording'&&Date.now()-recStartedAt>600);
  await pinch(page,4);
  await expect.poll(async()=>(await edge(page))[1]).toBeGreaterThan(240);
  await page.waitForFunction(()=>Date.now()-recStartedAt>1600);
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
  const result=await page.evaluate(async()=>{
    const clip=(await listVideos())[0], blob=await getBlob(clip.id);
    const video=document.createElement('video'),url=URL.createObjectURL(blob);
    video.muted=true;video.playsInline=true;video.src=url;
    try{
      await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Decode failed'));});
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
      const context=canvas.getContext('2d');
      const pixel=async time=>{
        await new Promise(resolve=>{video.onseeked=resolve;video.currentTime=time;});
        context.drawImage(video,0,0);
        return [...context.getImageData(100,100,1,1).data];
      };
      return {before:await pixel(0.2),after:await pixel(1.3),width:canvas.width,height:canvas.height,mime:clip.recordingMime};
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  });
  expect(result.width).toBe(1280);expect(result.height).toBe(720);
  expect(result.mime).toMatch(/hvc1|hev1/);
  expect(result.before[0]).toBeGreaterThan(200);expect(result.before[1]).toBeLessThan(25);
  expect(result.after[1]).toBeGreaterThan(200);expect(result.after[0]).toBeLessThan(25);
});
