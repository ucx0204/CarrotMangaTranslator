import { expect, it } from "vitest";
import { imageEditingFixture } from "./mcpImageEditing.fixture";
import { imageNativeBoundary } from "./mcpImageNative.fixture";
import { normalizeBboxTo1000 } from "../src/shared/bboxNormalization";

it("keeps the native block-mask authority identical for pixel and normalized source boxes",async()=>{
  const f=await imageEditingFixture();
  try{
    const {buildMcpImageEditMasks}=await import("../src/main/mcp/mcpImageEditMasks");
    const {buildPatternPageMask}=await import("../src/main/inpainting/patternPageMask");
    const page=(await f.snapshot()).pages[0];
    const normalized={...page,blocks:page.blocks.map((block)=>({...block,
      bbox:normalizeBboxTo1000(block.bbox,page,block.bboxSpace),bboxSpace:"normalized_1000" as const}))};
    const bitmap=imageNativeBoundary.createFromPath(page.imagePath).toBitmap();
    const command={kind:"erase-blocks" as const,blockIds:["a","b"],expectedEngine:"lama-manga" as const,
      allowAssetDownloads:true,protectedAreas:[]};
    const actual=buildMcpImageEditMasks(page,command,bitmap);
    expect(actual.mask).toEqual(buildMcpImageEditMasks(normalized,command,bitmap).mask);
    expect(actual.mask).toEqual(buildPatternPageMask({page:normalized,bitmap,width:100,height:100,
      blockIds:["a","b"],mode:"glyph"}).pageMask);
    expect(f.inpaint).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it("matches native retouch pixels exactly when no protection is requested",async()=>{
  const f=await imageEditingFixture();
  try{
    const {applyInpaintingRetouch}=await import("../src/main/inpainting");
    const before=(await f.snapshot()).pages[0];
    const geometry={kind:"ellipse" as const,start:{x:15,y:25},end:{x:35,y:45}};
    const native=await applyInpaintingRetouch(before,{mode:"paint",geometry,color:"#abcdef"});
    const plan=await f.preview({kind:"paint",geometry,color:"#abcdef",protectedAreas:[]});
    expect((await f.action(plan.batchId,"apply")).result.status).toBe("completed");
    const actual=(await f.snapshot()).pages[0];
    expect((await f.pixels(actual.inpaintedImagePath)).data).toEqual((await f.pixels(native.inpaintedImagePath)).data);
    expect(actual.blocks).toEqual(before.blocks);
  }finally{await f.close();}
});

it("rejects malformed trusted prepared masks and incompatible inputs before engine invocation",async()=>{
  const f=await imageEditingFixture();
  try{
    const {inpaintDrawnPatternPage}=await import("../src/main/inpainting/drawnPatternPage");
    const {applyInpaintingRetouch}=await import("../src/main/inpainting");
    const page=(await f.snapshot()).pages[0];
    const lease=await f.acquireEngine({appPaths:f.app.appPaths,model:"lama-manga"});
    const options={strokes:[],inpaintingEngine:lease.engine};
    for(const preparedMask of [new Uint8Array(1),new Uint8Array(10000).fill(2)])
      await expect(inpaintDrawnPatternPage(page,{...options,preparedMask})).rejects.toThrow(/Prepared mask/);
    await expect(inpaintDrawnPatternPage(page,{...options,preparedMask:new Uint8Array(10000),
      strokes:[{radiusPx:4,points:[{x:2,y:2}]}]})).rejects.toThrow(/not both/);
    await expect(inpaintDrawnPatternPage({...page,width:101},{...options,preparedMask:new Uint8Array(10000)})).rejects.toThrow(/Prepared mask/);
    await expect(applyInpaintingRetouch(page,{mode:"paint",color:"#abcdef",protectedMask:new Uint8Array(1),
      geometry:{kind:"rectangle",start:{x:1,y:1},end:{x:5,y:5}}})).rejects.toThrow(/Protected retouch/);
    expect(f.inpaint).not.toHaveBeenCalled();
    await lease.release();
  }finally{await f.close();}
});
