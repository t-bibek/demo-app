import Foundation

/// Incremental NDJSON (newline-delimited JSON) parser. Ported from
/// src/shared/ndjson.ts. Handles chunks that split lines arbitrarily.
///
/// On macOS the detection engine runs in-process, so this is used for the
/// session log file round-trip and to keep behavioural parity / tests.
public final class NdjsonParser {
    // Buffer as Unicode scalars, not Characters: Swift treats "\r\n" as a
    // single grapheme `Character`, so `firstIndex(of: "\n")` on a String would
    // miss LFs inside CRLF. The scalar view keeps "\r" and "\n" separate, just
    // like the original TS parser working over a UTF-16 string.
    private var scalars: [Unicode.Scalar] = []
    private let onValue: (Any) -> Void
    private let onBadLine: ((String, Error) -> Void)?

    public init(onValue: @escaping (Any) -> Void,
                onBadLine: ((String, Error) -> Void)? = nil) {
        self.onValue = onValue
        self.onBadLine = onBadLine
    }

    public func push(_ chunk: String) {
        scalars.append(contentsOf: chunk.unicodeScalars)
        while let nl = scalars.firstIndex(of: "\n") {
            let lineScalars = scalars[scalars.startIndex..<nl]
            var line = String(String.UnicodeScalarView(lineScalars))
            scalars.removeSubrange(scalars.startIndex...nl)
            if line.hasSuffix("\r") { line.removeLast() }
            line = line.trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { parseLine(line) }
        }
    }

    /// Flush a trailing line that was not newline-terminated (e.g. at exit).
    public func flush() {
        let line = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespaces)
        scalars.removeAll()
        if !line.isEmpty { parseLine(line) }
    }

    private func parseLine(_ line: String) {
        do {
            let obj = try JSONSerialization.jsonObject(with: Data(line.utf8), options: [])
            onValue(obj)
        } catch {
            onBadLine?(line, error)
        }
    }
}

/// Appends completed speaking sessions to an NDJSON log file (one JSON object
/// per line), matching the spirit of the original's session log output.
public final class NdjsonSessionLogger {
    public let url: URL
    private let queue = DispatchQueue(label: "msd.ndjson.logger")
    private var handle: FileHandle?

    public init?(url: URL) {
        self.url = url
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(),
                                withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil)
        }
        guard let h = try? FileHandle(forWritingTo: url) else { return nil }
        h.seekToEndOfFile()
        self.handle = h
    }

    public func logEnd(platform: Platform, name: String, startTs: Int, endTs: Int, durationMs: Int) {
        let obj: [String: Any] = [
            "type": "speaker-end",
            "platform": platform.rawValue,
            "name": name,
            "startTs": startTs,
            "endTs": endTs,
            "durationMs": durationMs,
        ]
        queue.async { [weak self] in
            guard let self, let h = self.handle else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
            h.write(data)
            h.write(Data([0x0a]))   // "\n"
        }
    }

    deinit {
        try? handle?.close()
    }
}
