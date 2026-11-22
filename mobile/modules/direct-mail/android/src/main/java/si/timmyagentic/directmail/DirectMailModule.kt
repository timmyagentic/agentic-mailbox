package si.timmyagentic.directmail

import directmail.Directmail
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DirectMailModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DirectMail")
    AsyncFunction("inbox") { address: String, password: String -> Directmail.inbox(address, password) }
    AsyncFunction("read") { address: String, password: String, validity: Double, uid: Double ->
      Directmail.read(address, password, validity.toLong(), uid.toLong())
    }
    AsyncFunction("send") { address: String, password: String, to: String, subject: String, body: String ->
      Directmail.send(address, password, to, subject, body)
    }
  }
}
