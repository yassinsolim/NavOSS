import CryptoKit
import Foundation
import Security

#if canImport(DeviceCheck)
  import DeviceCheck
#endif

public enum NavOSSCommunityAttestationError: Error, Equatable {
  /// App Attest is not available on this device or build. Reading reports still works.
  case unsupported
  /// The key is unknown to the Secure Enclave (deleted, restored to another device, or the app
  /// was reinstalled): generate and register a new one.
  case invalidKey
  /// Apple's attestation service could not be reached; try again later.
  case serviceUnavailable
  case failed
}

/// What `POST /v2/community/installations` needs besides the challenge and key id.
public enum NavOSSCommunityRegistrationMaterial: Equatable, Sendable {
  case appAttest(attestationObject: Data)
  case development(publicKey: Data)
}

/// Creates keys and signs for community writes. Production uses App Attest
/// (`NavOSSAppAttestProvider`); DEBUG builds without App Attest (the Simulator) use a software
/// key the server accepts only in `allow-development` mode, as an untrusted installation.
public protocol NavOSSCommunityAttestationProvider: Sendable {
  var isSupported: Bool { get }
  /// Generates a new key and returns its key id (base64, exactly as the server expects).
  func generateKey() async throws -> String
  func registrationMaterial(keyId: String, clientDataHash: Data) async throws
    -> NavOSSCommunityRegistrationMaterial
  /// The CBOR assertion object over `clientDataHash`.
  func assertion(keyId: String, clientDataHash: Data) async throws -> Data
  /// Forgets any local secret for `keyId` (App Attest keys cannot be deleted; they are abandoned).
  func discardKey(keyId: String)
}

// MARK: - Keychain

/// Small secret storage. The production store is the Keychain; tests use memory.
public protocol NavOSSCommunitySecretStore: Sendable {
  func data(for account: String) -> Data?
  func set(_ data: Data, for account: String) -> Bool
  func remove(_ account: String)
}

/// Keychain items readable after first unlock, so CarPlay can write while the phone is locked;
/// never synced or migrated to another device.
public struct NavOSSCommunityKeychain: NavOSSCommunitySecretStore {
  private let service: String

  public init(service: String = "org.navoss.mobile.community") {
    self.service = service
  }

  private func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  public func data(for account: String) -> Data? {
    var query = query(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  public func set(_ data: Data, for account: String) -> Bool {
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
    if status == errSecSuccess { return true }
    guard status == errSecItemNotFound else { return false }
    var item = query(account)
    item.merge(attributes) { _, new in new }
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  public func remove(_ account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }
}

public final class NavOSSCommunityMemorySecretStore: NavOSSCommunitySecretStore, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: Data] = [:]

  public init() {}

  public func data(for account: String) -> Data? {
    lock.withLock { items[account] }
  }

  public func set(_ data: Data, for account: String) -> Bool {
    lock.withLock { items[account] = data }
    return true
  }

  public func remove(_ account: String) {
    _ = lock.withLock { items.removeValue(forKey: account) }
  }
}

// MARK: - App Attest

#if canImport(DeviceCheck) && os(iOS)
  /// DCAppAttestService. Real keys live in the Secure Enclave; only the key id is stored.
  public struct NavOSSAppAttestProvider: NavOSSCommunityAttestationProvider {
    public init() {}

    public var isSupported: Bool {
      DCAppAttestService.shared.isSupported
    }

    public func generateKey() async throws -> String {
      guard isSupported else { throw NavOSSCommunityAttestationError.unsupported }
      do {
        return try await DCAppAttestService.shared.generateKey()
      } catch {
        throw Self.mapped(error)
      }
    }

    public func registrationMaterial(
      keyId: String,
      clientDataHash: Data
    ) async throws -> NavOSSCommunityRegistrationMaterial {
      do {
        return .appAttest(
          attestationObject: try await DCAppAttestService.shared.attestKey(
            keyId,
            clientDataHash: clientDataHash
          )
        )
      } catch {
        throw Self.mapped(error)
      }
    }

    public func assertion(keyId: String, clientDataHash: Data) async throws -> Data {
      do {
        return try await DCAppAttestService.shared.generateAssertion(
          keyId,
          clientDataHash: clientDataHash
        )
      } catch {
        throw Self.mapped(error)
      }
    }

    public func discardKey(keyId: String) {}

    private static func mapped(_ error: Error) -> NavOSSCommunityAttestationError {
      guard let error = error as? DCError else { return .failed }
      switch error.code {
      case .featureUnsupported: return .unsupported
      case .invalidKey: return .invalidKey
      case .serverUnavailable: return .serviceUnavailable
      default: return .failed
      }
    }
  }
#endif

/// Always unsupported: the build has no way to attest.
public struct NavOSSUnavailableAttestationProvider: NavOSSCommunityAttestationProvider {
  public init() {}
  public var isSupported: Bool { false }
  public func generateKey() async throws -> String {
    throw NavOSSCommunityAttestationError.unsupported
  }
  public func registrationMaterial(keyId: String, clientDataHash: Data) async throws
    -> NavOSSCommunityRegistrationMaterial
  {
    throw NavOSSCommunityAttestationError.unsupported
  }
  public func assertion(keyId: String, clientDataHash: Data) async throws -> Data {
    throw NavOSSCommunityAttestationError.unsupported
  }
  public func discardKey(keyId: String) {}
}

#if DEBUG
  /// DEBUG builds only (compiled out of Release): a software P-256 key in App Attest's assertion
  /// format, for the Simulator against a server in `COMMUNITY_ATTESTATION_MODE=allow-development`.
  /// The server registers it as `untrusted`: its reports are never shown to anyone.
  public final class NavOSSDevelopmentAttestationProvider: NavOSSCommunityAttestationProvider,
    @unchecked Sendable
  {
    private struct StoredKey: Codable {
      let counter: UInt32
      let privateKey: Data
    }

    private let lock = NSLock()
    private let rpIdHash: Data
    private let store: NavOSSCommunitySecretStore
    /// Keys generated but not yet registered, held in memory until registration succeeds.
    private var pendingKeys: [String: P256.Signing.PrivateKey] = [:]

    public init(teamId: String, bundleId: String, store: NavOSSCommunitySecretStore) {
      rpIdHash = Data(SHA256.hash(data: Data("\(teamId).\(bundleId)".utf8)))
      self.store = store
    }

    public var isSupported: Bool { true }

    private static func account(_ keyId: String) -> String {
      "development-key.\(keyId)"
    }

    /// Same derivation as App Attest: SHA-256 of the uncompressed SEC1 public point.
    static func keyId(for publicKey: P256.Signing.PublicKey) -> String {
      Data(SHA256.hash(data: publicKey.x963Representation)).base64EncodedString()
    }

    public func generateKey() async throws -> String {
      let key = P256.Signing.PrivateKey()
      let keyId = Self.keyId(for: key.publicKey)
      lock.withLock { pendingKeys[keyId] = key }
      return keyId
    }

    public func registrationMaterial(
      keyId: String,
      clientDataHash: Data
    ) async throws -> NavOSSCommunityRegistrationMaterial {
      guard let key = lock.withLock({ pendingKeys.removeValue(forKey: keyId) }) else {
        throw NavOSSCommunityAttestationError.invalidKey
      }
      let stored = StoredKey(counter: 0, privateKey: key.rawRepresentation)
      guard let data = try? JSONEncoder().encode(stored), store.set(data, for: Self.account(keyId))
      else {
        throw NavOSSCommunityAttestationError.failed
      }
      return .development(publicKey: key.publicKey.derRepresentation)
    }

    public func assertion(keyId: String, clientDataHash: Data) async throws -> Data {
      try lock.withLock {
        guard let data = store.data(for: Self.account(keyId)),
          let stored = try? JSONDecoder().decode(StoredKey.self, from: data),
          let key = try? P256.Signing.PrivateKey(rawRepresentation: stored.privateKey)
        else {
          throw NavOSSCommunityAttestationError.invalidKey
        }
        let counter = stored.counter &+ 1
        guard let updated = try? JSONEncoder().encode(
          StoredKey(counter: counter, privateKey: stored.privateKey)),
          store.set(updated, for: Self.account(keyId))
        else {
          throw NavOSSCommunityAttestationError.failed
        }
        var authenticatorData = rpIdHash
        authenticatorData.append(0x40)
        withUnsafeBytes(of: counter.bigEndian) { authenticatorData.append(contentsOf: $0) }
        var signed = authenticatorData
        signed.append(clientDataHash)
        let nonce = Data(SHA256.hash(data: signed))
        // ECDSA P-256 with SHA-256 over the nonce, as Apple's verification steps and the
        // server's `verify('sha256', nonce, …)` expect.
        let signature = try key.signature(for: nonce).derRepresentation
        return navOSSCBORAssertion(signature: signature, authenticatorData: authenticatorData)
      }
    }

    public func discardKey(keyId: String) {
      store.remove(Self.account(keyId))
    }
  }
#endif

/// `{ "signature": bstr, "authenticatorData": bstr }` in canonical CBOR, the shape of
/// DCAppAttestService assertions.
func navOSSCBORAssertion(signature: Data, authenticatorData: Data) -> Data {
  func text(_ value: String) -> Data {
    var data = navOSSCBORHead(major: 3, length: value.utf8.count)
    data.append(Data(value.utf8))
    return data
  }
  func bytes(_ value: Data) -> Data {
    var data = navOSSCBORHead(major: 2, length: value.count)
    data.append(value)
    return data
  }
  var data = Data([0xa2])
  data.append(text("signature"))
  data.append(bytes(signature))
  data.append(text("authenticatorData"))
  data.append(bytes(authenticatorData))
  return data
}

private func navOSSCBORHead(major: UInt8, length: Int) -> Data {
  let type = major << 5
  switch length {
  case ..<24: return Data([type | UInt8(length)])
  case ..<0x100: return Data([type | 24, UInt8(length)])
  default: return Data([type | 25, UInt8(length >> 8), UInt8(length & 0xff)])
  }
}
