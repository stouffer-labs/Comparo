class Comparo < Formula
  desc "MCP server that orchestrates Claude Code, Codex CLI, and Gemini CLI for cross-validation"
  homepage "https://github.com/stouffer-labs/Comparo"
  url "https://github.com/stouffer-labs/Comparo/archive/refs/heads/main.tar.gz"
  version "main"
  sha256 :no_check
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "ci", "--omit=dev"
    system "npm", "run", "build"
    libexec.install Dir["*"]
    (bin/"comparo").write_env_script libexec/"bin/comparo.js", {}
  end

  test do
    assert_match "0.1.0", shell_output("#{bin}/comparo --version")
  end
end
