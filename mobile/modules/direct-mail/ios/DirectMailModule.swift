import Directmail
import ExpoModulesCore

public class DirectMailModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DirectMail")
    AsyncFunction("inbox") { (address: String, password: String) throws -> String in
      var error: NSError?
      let result = DirectmailInbox(address, password, &error)
      if let error { throw error }
      return result
    }
    AsyncFunction("read") { (address: String, password: String, validity: Double, uid: Double) throws -> String in
      var error: NSError?
      let result = DirectmailRead(address, password, Int64(validity), Int64(uid), &error)
      if let error { throw error }
      return result
    }
    AsyncFunction("send") { (address: String, password: String, to: String, subject: String, body: String) throws in
      var error: NSError?
      DirectmailSend(address, password, to, subject, body, &error)
      if let error { throw error }
    }
  }
}
