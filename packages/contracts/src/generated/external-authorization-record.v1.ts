/* generated; source is JSON Schema */

/**
 * The school and research-ethics decision that admits real students. Engineering supplies the format and the validator and cannot self-issue the decision. Every dimension of the scope is named here explicitly - the rooms are listed, the cohort is counted, the window is closed at both ends, the surfaces are enumerated - so widening the pilot needs a new signed decision rather than a wider reading of this one.
 */
export interface ExternalAuthorizationRecord {
  recordKind: "external_authorization";
  authorizationId: string;
  /**
   * A synthetic record is a rehearsal of the paperwork and is not an authorization. True is refused.
   */
  synthetic: boolean;
  /**
   * Who decided. The body is carried as a salted digest of its identity, never the identity itself.
   */
  authorizingBody: {
    bodyKind: "school" | "research_ethics_board" | "school_and_research_ethics_board";
    bodyRef: string;
    approvalReference: string;
    decidedAt: string;
  };
  /**
   * What was authorized. There is no wildcard and no open end: a room not listed here was not authorized.
   */
  scope: {
    schoolRef: string;
    classRef: string;
    /**
     * @minItems 1
     * @maxItems 20
     */
    roomIds:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ];
    maxStudentsPerRoom: number;
    /**
     * The largest number of distinct students the body admitted across every authorized room.
     */
    maxStudentsTotal: number;
    sessionsFrom: string;
    sessionsUntil: string;
  };
  /**
   * The named teacher who supervises the authorized sessions, as a salted digest.
   */
  supervisingTeacherRef: string;
  /**
   * Who may stop the pilot, as a salted digest.
   */
  rollbackOwnerRef: string;
  /**
   * @minItems 1
   * @maxItems 5
   */
  incidentContactRefs:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
  /**
   * How participants and their guardians were informed, and by when consent was held. Sessions may not begin before that date.
   */
  participantInformation: {
    informationSheetSha256: string;
    consentPath: "guardian_written_opt_in" | "guardian_and_student_written_opt_in";
    consentObtainedBy: string;
  };
  /**
   * The documents the body actually reviewed, bound by digest. Exactly one entry per required kind: a decision taken over a document version nobody can name is not reviewable later.
   *
   * @minItems 3
   * @maxItems 3
   */
  reviewedDocuments: [
    {
      documentKind: "threat_model" | "data_inventory" | "retention_policy";
      documentSha256: string;
      reviewedAt: string;
    },
    {
      documentKind: "threat_model" | "data_inventory" | "retention_policy";
      documentSha256: string;
      reviewedAt: string;
    },
    {
      documentKind: "threat_model" | "data_inventory" | "retention_policy";
      documentSha256: string;
      reviewedAt: string;
    }
  ];
  /**
   * The pilot retention policy version these sessions run under.
   */
  retentionPolicyId: string;
  /**
   * The exact model provider the decision covers. `no_persistent_copy_attested` must name the signed copy-authority record and its expiry; `delete_and_probe` must name the reviewed capability and port schema versions. Neither may name the other's fields, and no URL, endpoint or secret appears here.
   */
  providerScope: {
    providerId: string;
    providerManifestSha256: string;
    region: string;
    purpose: string;
    remoteCopyMode: "no_persistent_copy_attested" | "delete_and_probe";
    copyAuthorityRecordSha256?: string;
    copyAuthorityExpiresAt?: string;
    capabilitySchemaVersion?: string;
    portSchemaVersion?: string;
  };
  /**
   * The surfaces this decision opens. Student-visible ECHO and TRACE are deliberately absent from the vocabulary: showing students the analytics built from their own conversation is a separate signed decision, and cannot be reached from here.
   *
   * @minItems 1
   * @maxItems 5
   */
  featureAllowlist:
    | ["room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export"]
    | [
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export"
      ]
    | [
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export"
      ]
    | [
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export"
      ]
    | [
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export",
        "room_chat" | "media_upload" | "agent_nova" | "teacher_analytics" | "teacher_export"
      ];
  /**
   * Whether the analytics feed grades or discipline. True is refused; the pilot makes no claim about an individual student.
   */
  usedForGradesOrDiscipline: boolean;
  /**
   * Who may sign for the body, as salted digests. Naming a signer is not itself proof - the envelope signature is.
   *
   * @minItems 1
   * @maxItems 5
   */
  authorizedSignerRefs:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
}
