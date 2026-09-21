import subprocess

class Runner:
    def run(self):
        return subprocess.run(["ls"])

Runner().run()
