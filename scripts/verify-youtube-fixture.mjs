#!/usr/bin/env node
import { verifyFixture } from "./youtube-fixture-lib.mjs";

const directory = process.argv[2];
if (!directory || process.argv.length > 3) {
  console.error("사용법: npm run fixture:check -- <YouTube fixture 디렉터리>");
  process.exitCode = 2;
} else {
  try {
    const result = await verifyFixture(directory);
    console.log(`fixture 정상: ${result.directory}`);
    console.log(`- ${result.title} (${result.videoId})`);
    console.log(`- ${result.language} ${result.subtitleKind} 자막 ${result.segments}개`);
    if (result.audio) {
      console.log(`- ${result.audio.durationSeconds.toFixed(2)}초 / ${result.audio.codec} / ${result.audio.sampleRate}Hz`);
    } else {
      console.log("- 자막 전용 fixture (오디오 없음)");
    }
  } catch (error) {
    console.error(`fixture 검증 실패: ${error.message}`);
    process.exitCode = 1;
  }
}
