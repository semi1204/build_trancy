package bench;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.thoroldvix.api.TranscriptApiFactory;
import io.github.thoroldvix.api.TranscriptContent;
import io.github.thoroldvix.api.YoutubeTranscriptApi;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

public final class Main {
    private static final String TOOL = "trldvix/youtube-transcript-api";
    private static final String TOOL_VERSION = "0.4.0";
    private static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final Pattern LANGUAGE = Pattern.compile("^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$");
    private static final ObjectMapper JSON = new ObjectMapper();

    private record Request(String mode, String videoId, String lang) {}

    private Main() {}

    public static void main(String[] args) throws Exception {
        Request request;
        try {
            request = JSON.readValue(System.in, Request.class);
        } catch (Exception error) {
            emit(errorResult("input", null, null, null, error));
            return;
        }

        if ("smoke".equals(request.mode())) {
            TranscriptApiFactory.createDefault();
            Map<String, Object> result = baseResult("smoke", true, null, null, 0L);
            result.put("segments", List.of());
            emit(result);
            return;
        }

        String videoId = request.videoId() == null ? "" : request.videoId();
        String language = request.lang() == null ? "" : request.lang();
        if (!VIDEO_ID.matcher(videoId).matches() || !LANGUAGE.matcher(language).matches()) {
            emit(errorResult("live", videoId, language, null,
                    new IllegalArgumentException("videoId 또는 lang 형식이 잘못됐습니다")));
            return;
        }

        long started = System.nanoTime();
        try {
            YoutubeTranscriptApi api = TranscriptApiFactory.createDefault();
            TranscriptContent transcript = api.getTranscript(videoId, language);
            List<Map<String, Object>> segments = new ArrayList<>();
            for (TranscriptContent.Fragment fragment : transcript.getContent()) {
                String text = cleanText(fragment.getText());
                if (text.isEmpty()) continue;
                double start = fragment.getStart();
                Map<String, Object> segment = new LinkedHashMap<>();
                segment.put("start", start);
                segment.put("end", start + fragment.getDur());
                segment.put("text", text);
                segments.add(segment);
            }
            Map<String, Object> result = baseResult("live", true, videoId, language, elapsedMs(started));
            result.put("segments", segments);
            emit(result);
        } catch (Exception error) {
            emit(errorResult("live", videoId, language, elapsedMs(started), error));
        }
    }

    private static String cleanText(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    private static long elapsedMs(long started) {
        return Math.round((System.nanoTime() - started) / 1_000_000.0);
    }

    private static Map<String, Object> baseResult(
            String mode, boolean ok, String videoId, String language, Long libraryMs) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", 1);
        result.put("tool", TOOL);
        result.put("toolVersion", TOOL_VERSION);
        result.put("ok", ok);
        result.put("mode", mode);
        if (videoId != null) result.put("videoId", videoId);
        if (language != null) result.put("lang", language);
        result.put("libraryMs", libraryMs);
        return result;
    }

    private static Map<String, Object> errorResult(
            String mode, String videoId, String language, Long libraryMs, Exception error) {
        Map<String, Object> result = baseResult(mode, false, videoId, language, libraryMs);
        Map<String, String> detail = new LinkedHashMap<>();
        detail.put("name", error.getClass().getSimpleName());
        detail.put("message", String.valueOf(error.getMessage()));
        result.put("error", detail);
        return result;
    }

    private static void emit(Map<String, Object> result) throws Exception {
        JSON.writeValue(System.out, result);
        System.out.println();
    }
}
