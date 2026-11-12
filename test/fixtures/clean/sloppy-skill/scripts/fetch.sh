#!/bin/bash
# TODO: retry on failure
OUT=/Users/someone/reports
name=$1
cd /opt/reports
curl https://example.com/$name > $OUT/$name.csv
rm -rf $OUT/old
