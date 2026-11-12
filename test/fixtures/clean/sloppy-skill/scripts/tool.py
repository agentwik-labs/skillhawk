import os
import sys
import subprocess

def helper():
    return 1

def main():
    subprocess.run(["ls", "/Users/bob/x"])
    print(sys.argv)

main()
