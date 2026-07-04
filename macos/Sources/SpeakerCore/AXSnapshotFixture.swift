import Foundation

/// Decoder for RAW `swift run AXSnapshot` dumps ({meta:…, tree:…}) into the
/// platform-free node the pure extractors consume — so a captured fixture is
/// committed AS-IS (no hand-distillation step between "what the tool saw" and
/// "what the test replays"). Only the fields the extractors read are decoded;
/// everything else (attributes map, url, identifiers, state booleans) is
/// ignored by the CodingKeys.
public struct AXSnapshotFixture: Decodable {
    public var tree: Node

    public struct Node: Decodable {
        public var role: String?
        public var subrole: String?
        public var roleDescription: String?
        public var title: String?
        public var desc: String?
        public var value: String?
        public var help: String?
        public var domClassList: [String]?
        public var frame: Frame?
        public var children: [Node]?

        public struct Frame: Decodable {
            public var x: Double?
            public var y: Double?
            public var w: Double?
            public var h: Double?
        }

        enum CodingKeys: String, CodingKey {
            case role, subrole, roleDescription, title, value, help, domClassList, frame, children
            case desc = "description"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            role = try c.decodeIfPresent(String.self, forKey: .role)
            subrole = try c.decodeIfPresent(String.self, forKey: .subrole)
            roleDescription = try c.decodeIfPresent(String.self, forKey: .roleDescription)
            title = Self.lossyText(c, .title)
            desc = Self.lossyText(c, .desc)
            value = Self.lossyText(c, .value)
            help = Self.lossyText(c, .help)
            domClassList = try? c.decodeIfPresent([String].self, forKey: .domClassList)
            frame = try? c.decodeIfPresent(Frame.self, forKey: .frame)
            children = try c.decodeIfPresent([Node].self, forKey: .children)
        }

        /// AXSnapshot writes text attrs through `AX.string`, but a slider /
        /// checkbox AXValue can surface as a number or bool — render those to
        /// text rather than failing the whole fixture.
        private static func lossyText(_ c: KeyedDecodingContainer<CodingKeys>,
                                      _ key: CodingKeys) -> String? {
            if let s = try? c.decodeIfPresent(String.self, forKey: key) { return s }
            if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return String(d) }
            if let b = try? c.decodeIfPresent(Bool.self, forKey: key) { return String(b) }
            return nil
        }
    }

    /// Decode a raw AXSnapshot dump and map it to the extractor node.
    public static func load(_ data: Data) throws -> ZoomAXNode {
        let fixture = try JSONDecoder().decode(AXSnapshotFixture.self, from: data)
        return node(fixture.tree)
    }

    private static func node(_ n: Node) -> ZoomAXNode {
        ZoomAXNode(role: n.role, subrole: n.subrole, roleDescription: n.roleDescription,
                   desc: n.desc, title: n.title,
                   value: n.value, help: n.help, classes: n.domClassList ?? [],
                   x: n.frame?.x, y: n.frame?.y, w: n.frame?.w, h: n.frame?.h,
                   children: (n.children ?? []).map(node))
    }
}
